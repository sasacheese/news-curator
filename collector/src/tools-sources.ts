import { fetchFeed } from './rss.js';
import type { ToolCandidate } from './tools.js';
import type { ToolIdentity } from './types.js';
import { fetchJson, log, mapLimit, safe, truncate } from './util.js';

/* ------------------------------------------------------------------ *
 * 入口B: 道具専用のソース
 *
 * いつもの収集（記事）には載らない道具を、道具の一覧から直接拾う。
 * 設定は config/tools.json。どのソースも落ちたら空で返し、道具箱全体は止めない。
 *
 * カタログ型（公式プラグインのマーケットプレイス・anthropics/skills）は日付を持たないので、
 * 「台帳にまだ無いもの」を 1 回あたり maxNewPerRun 件ずつ入れる。初回に数百件が
 * 一度に並ぶのを避けつつ、既存のカタログも 2〜3 週間かけて一通り目に入るようにするため。
 * ------------------------------------------------------------------ */

export interface ToolSourcesConfig {
  mcpRegistry: { enabled: boolean; maxPages: number; maxItems: number };
  claudeMarketplace: { enabled: boolean; url: string; maxNewPerRun: number };
  anthropicSkills: { enabled: boolean; repo: string; path: string; maxNewPerRun: number };
  githubTopics: { enabled: boolean; topics: string[]; createdWithinDays: number; minStars: number; perTopic: number };
  cloudFeeds: { enabled: boolean; feeds: { label: string; url: string }[]; maxPerFeed: number };
  productHunt: { enabled: boolean; url: string; maxItems: number };
}

export interface SourceContext {
  date: string;
  windowStart: Date;
  /** 台帳にすでにある身元か（カタログ型の差分取りに使う） */
  known: (identity: ToolIdentity) => boolean;
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function githubRepoOf(url: string | null | undefined): string | null {
  const m = url ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/* ---------- MCP Registry ---------- */

interface McpServer {
  server: {
    name: string;
    title?: string;
    description?: string;
    websiteUrl?: string;
    repository?: { url?: string };
    packages?: {
      registryType?: string;
      identifier?: string;
      environmentVariables?: { isRequired?: boolean; isSecret?: boolean }[];
    }[];
    remotes?: { url?: string; headers?: { isSecret?: boolean; isRequired?: boolean }[] }[];
  };
  _meta?: Record<string, { publishedAt?: string; isLatest?: boolean; status?: string } | undefined>;
}

export function mcpCandidate(s: McpServer, ctx: Pick<SourceContext, 'date' | 'windowStart'>): ToolCandidate | null {
  const meta = s._meta?.['io.modelcontextprotocol.registry/official'];
  if (meta?.status && meta.status !== 'active') return null;
  if (meta?.isLatest === false) return null;
  if (meta?.publishedAt && new Date(meta.publishedAt) < ctx.windowStart) return null;

  const npm = s.server.packages?.find((p) => p.registryType === 'npm')?.identifier;
  const github = githubRepoOf(s.server.repository?.url);
  const remote = s.server.remotes?.[0]?.url;
  const identity: ToolIdentity = github ? { github } : npm ? { npm } : {};
  if (!identity.github && !identity.npm) {
    const url = s.server.websiteUrl ?? remote;
    if (!url) return null;
    identity.url = url;
  }
  if (npm && !identity.npm) identity.npm = npm;

  const needsKey =
    s.server.packages?.some((p) => p.environmentVariables?.some((e) => e.isRequired && e.isSecret)) ||
    s.server.remotes?.some((r) => r.headers?.some((h) => h.isSecret));
  const homepage = github
    ? `https://github.com/${github}`
    : npm
      ? `https://www.npmjs.com/package/${npm}`
      : (identity.url ?? '');
  return {
    identity,
    name: s.server.title ?? s.server.name,
    homepage,
    kindHint: 'mcp',
    description: s.server.description ?? null,
    requires: [...(needsKey ? ['API キー'] : []), ...(remote && !npm ? ['リモート接続'] : [])],
    signal: { source: 'mcp-registry', date: ctx.date, strength: 0.6, title: s.server.description, url: homepage },
  };
}

async function fromMcpRegistry(cfg: ToolSourcesConfig['mcpRegistry'], ctx: SourceContext): Promise<ToolCandidate[]> {
  const out: ToolCandidate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < cfg.maxPages; page++) {
    const q = new URLSearchParams({ limit: '100', updated_since: ctx.windowStart.toISOString() });
    if (cursor) q.set('cursor', cursor);
    const res = await fetchJson<{ servers: McpServer[]; metadata?: { nextCursor?: string } }>(
      `https://registry.modelcontextprotocol.io/v0/servers?${q}`,
    );
    for (const s of res.servers ?? []) {
      const c = mcpCandidate(s, ctx);
      if (c) out.push(c);
    }
    cursor = res.metadata?.nextCursor;
    if (!cursor) break;
  }
  /*
   * 1 日 200 件を超える（実測 215 件）。版の更新も「更新」として返るので、そのままだと
   * 盤面が MCP だけで埋まる。台帳に無いものを優先し、その中ではリポジトリを公開している
   * もの（中身を確かめられる）を先に取る。
   */
  return out
    .filter((c) => !ctx.known(c.identity))
    .sort((a, b) => Number(Boolean(b.identity.github)) - Number(Boolean(a.identity.github)))
    .slice(0, cfg.maxItems);
}

/* ---------- Claude Code 公式プラグインのマーケットプレイス ---------- */

interface MarketplacePlugin {
  name: string;
  description?: string;
  author?: { name?: string };
  category?: string;
  homepage?: string;
  source?: string | { source?: string; url?: string; path?: string; repo?: string };
}

export function marketplaceCandidate(p: MarketplacePlugin, date: string, marketplaceUrl: string): ToolCandidate | null {
  const src = typeof p.source === 'object' ? p.source : null;
  const repoUrl = src?.url ?? (src?.repo ? `https://github.com/${src.repo}` : undefined);
  const github = githubRepoOf(repoUrl);
  /*
   * 1 つのリポジトリに複数のプラグインを置く形（git-subdir）が多い。リポジトリを身元にすると
   * 別のプラグインが同じ道具に潰れるので、その場合はプラグインの置き場所の URL を身元にする。
   */
  const subdir = src?.path && github ? `https://github.com/${github}/tree/HEAD/${src.path}` : null;
  const homepage = p.homepage ?? subdir ?? (github ? `https://github.com/${github}` : null);
  const identity: ToolIdentity = subdir || !github ? { url: homepage ?? `${marketplaceUrl}#${p.name}` } : { github };
  return {
    identity,
    name: p.name,
    homepage: homepage ?? marketplaceUrl,
    kindHint: 'plugin',
    description: p.description ?? null,
    trust: { author: p.author?.name ?? null, official: /^anthropic$/i.test(p.author?.name ?? '') },
    signal: { source: 'claude-marketplace', date, strength: 0.5, title: p.category, url: homepage ?? undefined },
  };
}

async function fromClaudeMarketplace(
  cfg: ToolSourcesConfig['claudeMarketplace'],
  ctx: SourceContext,
): Promise<ToolCandidate[]> {
  const res = await fetchJson<{ plugins?: MarketplacePlugin[] }>(cfg.url);
  const all = (res.plugins ?? []).flatMap((p) => marketplaceCandidate(p, ctx.date, cfg.url) ?? []);
  // 追加は末尾に来ることが多いので、後ろから未知のものを取る
  return all.reverse().filter((c) => !ctx.known(c.identity)).slice(0, cfg.maxNewPerRun);
}

/* ---------- anthropics/skills ---------- */

async function fromAnthropicSkills(
  cfg: ToolSourcesConfig['anthropicSkills'],
  ctx: SourceContext,
): Promise<ToolCandidate[]> {
  const entries = await fetchJson<{ name: string; type: string; html_url: string }[]>(
    `https://api.github.com/repos/${cfg.repo}/contents/${cfg.path}`,
    { headers: githubHeaders() },
  );
  return entries
    .filter((e) => e.type === 'dir')
    .map(
      (e): ToolCandidate => ({
        identity: { url: e.html_url },
        name: e.name,
        homepage: e.html_url,
        kindHint: 'skill',
        trust: { official: true, author: cfg.repo.split('/')[0] ?? null },
        signal: { source: 'anthropic-skills', date: ctx.date, strength: 0.5, url: e.html_url },
      }),
    )
    .filter((c) => !ctx.known(c.identity))
    .slice(0, cfg.maxNewPerRun);
}

/* ---------- GitHub topic ---------- */

async function fromGithubTopics(cfg: ToolSourcesConfig['githubTopics'], ctx: SourceContext): Promise<ToolCandidate[]> {
  const since = new Date(`${ctx.date}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - cfg.createdWithinDays);
  const day = since.toISOString().slice(0, 10);
  const nested = await mapLimit(cfg.topics, 2, (topic) =>
    safe(
      `tools:gh-topic(${topic})`,
      async () => {
        const q = encodeURIComponent(`topic:${topic} created:>=${day} stars:>=${cfg.minStars}`);
        const res = await fetchJson<{
          items: { full_name: string; html_url: string; description: string | null; stargazers_count: number; topics?: string[] }[];
        }>(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${cfg.perTopic}`, {
          headers: githubHeaders(),
        });
        return (res.items ?? []).map(
          (r): ToolCandidate => ({
            identity: { github: r.full_name },
            name: r.full_name.split('/')[1] ?? r.full_name,
            homepage: r.html_url,
            description: r.description,
            trust: { stars: r.stargazers_count },
            signal: { source: `gh-topic:${topic}`, date: ctx.date, strength: 0.6, title: r.description ?? undefined, url: r.html_url },
          }),
        );
      },
      [] as ToolCandidate[],
    ),
  );
  return nested.flat();
}

/* ---------- クラウドの新サービス ---------- */

/**
 * 新製品・一般提供（GA）だけを残す。機能追加・リージョン追加は今日タブのリリース情報の
 * 役割で、道具箱に入れると「既存サービスの小さな更新」で棚が埋まる。
 */
const CLOUD_NEW_RE =
  /generally available|\bGA\b|now available|introducing|announc(?:es|ing) .*\bnew\b|\blaunch(?:es|ed)?\b|一般提供|提供開始|新サービス|リリースしました/i;
const CLOUD_NOISE_RE = /\bregions?\b|リージョン|price reduction|値下げ|deprecat|end of support|サポート終了/i;

export function isCloudLaunch(title: string): boolean {
  return CLOUD_NEW_RE.test(title) && !CLOUD_NOISE_RE.test(title);
}

async function fromCloudFeeds(cfg: ToolSourcesConfig['cloudFeeds'], ctx: SourceContext): Promise<ToolCandidate[]> {
  const nested = await mapLimit(cfg.feeds, 3, (feed) =>
    safe(
      `tools:cloud(${feed.label})`,
      async () => {
        const entries = await fetchFeed(feed.url);
        return entries
          .filter((e) => e.publishedAt && e.publishedAt >= ctx.windowStart && e.link && isCloudLaunch(e.title))
          .slice(0, cfg.maxPerFeed)
          .map(
            (e): ToolCandidate => ({
              identity: { url: e.link },
              name: truncate(e.title, 80),
              homepage: e.link,
              kindHint: 'cloud',
              description: truncate(e.summary || e.content || '', 400) || null,
              trust: { official: true, author: feed.label },
              signal: { source: `cloud:${feed.label}`, date: ctx.date, strength: 0.5, title: e.title, url: e.link },
            }),
          );
      },
      [] as ToolCandidate[],
    ),
  );
  return nested.flat();
}

/* ---------- Product Hunt ---------- */

async function fromProductHunt(cfg: ToolSourcesConfig['productHunt'], ctx: SourceContext): Promise<ToolCandidate[]> {
  const entries = await fetchFeed(cfg.url);
  return entries
    .filter((e) => e.publishedAt && e.publishedAt >= ctx.windowStart && e.link)
    .slice(0, cfg.maxItems)
    .map(
      (e): ToolCandidate => ({
        identity: { url: e.link },
        name: e.title,
        homepage: e.link,
        kindHint: 'saas',
        // フィードの本文は「キャッチコピー + Discussion | Link」なので、最初の文だけ使う
        description: truncate((e.summary || e.content || '').replace(/\s*Discussion\s*\|\s*Link\s*$/i, ''), 200) || null,
        signal: { source: 'product-hunt', date: ctx.date, strength: 0.4, title: e.title, url: e.link },
      }),
    );
}

export async function collectToolSources(cfg: ToolSourcesConfig, ctx: SourceContext): Promise<ToolCandidate[]> {
  const runs: [string, boolean, () => Promise<ToolCandidate[]>][] = [
    ['mcp-registry', cfg.mcpRegistry.enabled, () => fromMcpRegistry(cfg.mcpRegistry, ctx)],
    ['claude-marketplace', cfg.claudeMarketplace.enabled, () => fromClaudeMarketplace(cfg.claudeMarketplace, ctx)],
    ['anthropic-skills', cfg.anthropicSkills.enabled, () => fromAnthropicSkills(cfg.anthropicSkills, ctx)],
    ['github-topics', cfg.githubTopics.enabled, () => fromGithubTopics(cfg.githubTopics, ctx)],
    ['cloud', cfg.cloudFeeds.enabled, () => fromCloudFeeds(cfg.cloudFeeds, ctx)],
    ['product-hunt', cfg.productHunt.enabled, () => fromProductHunt(cfg.productHunt, ctx)],
  ];
  const results = await Promise.all(
    runs.filter(([, on]) => on).map(async ([label, , run]) => {
      const got = await safe(`tools:${label}`, run, [] as ToolCandidate[]);
      log.info(`  [道具] ${label}: ${got.length} 件`);
      return got;
    }),
  );
  return results.flat();
}
