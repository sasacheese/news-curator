import type { ToolEntry, ToolKind } from './types.js';
import { fetchJson, log, mapLimit } from './util.js';

/* ------------------------------------------------------------------ *
 * 道具の種類と信頼の目印を取りに行く（1 道具 1 回だけ）
 *
 * 種類はルールベースで決める。LLM に聞くと「CLI でもありライブラリでもある」ものを
 * 日によって違う棚に入れるので、ファイルの有無・package.json の bin のような
 * 機械的な証拠だけで決め、決められなければ other にする。
 * ------------------------------------------------------------------ */

/** 種類の判定に使う事実。どこから取ったかは問わない */
export interface KindFacts {
  /** リポジトリ直下のファイル・ディレクトリ名 */
  rootFiles?: string[];
  topics?: string[];
  name?: string;
  description?: string | null;
  /** npm の bin があるか。npm を見ていなければ undefined */
  npmHasBin?: boolean;
  npmKeywords?: string[];
}

const MCP_RE = /(^|[^a-z])mcp([^a-z]|$)|model ?context ?protocol/i;
const CLI_RE = /\bcli\b|command[- ]line|コマンドライン|\bterminal\b|ターミナル/i;
const LIB_RE = /\blibrary\b|\bsdk\b|\bframework\b|ライブラリ|フレームワーク/i;

/**
 * 判定の順番に意味がある。Skill / Plugin は専用のファイルで確定するので先に見る。
 * MCP は名前や topic で名乗るのが慣習なので次。CLI とライブラリは最後で、
 * npm の bin があればそれを正とし、無ければ説明文の語で決める。
 */
export function classifyKind(f: KindFacts): ToolKind {
  const files = new Set((f.rootFiles ?? []).map((x) => x.toLowerCase()));
  const topics = (f.topics ?? []).map((t) => t.toLowerCase());
  const text = `${f.name ?? ''} ${f.description ?? ''}`;

  /*
   * .claude-plugin は「本体がコードのリポジトリが、自分用のプラグインを同梱している」形も多い
   * （実測で CopilotKit がこれ）。パッケージの定義ファイルがあれば本体はコードとみなし、
   * プラグインとは判定しない——誤ってプラグインの棚に入れるより、下の規則に任せるほうが外れにくい。
   */
  const isCodeProject = ['package.json', 'cargo.toml', 'pyproject.toml', 'go.mod', 'setup.py'].some((f) =>
    files.has(f),
  );
  if (
    (files.has('.claude-plugin') && !isCodeProject) ||
    topics.some((t) => /claude-code-plugin|cursor-plugin/.test(t))
  ) {
    return 'plugin';
  }
  if (files.has('skill.md') || topics.some((t) => /claude-skills?|agent-skills?/.test(t))) return 'skill';
  if (
    topics.some((t) => t === 'mcp' || t.startsWith('mcp-') || t.endsWith('-mcp')) ||
    (f.npmKeywords ?? []).some((k) => /^(mcp|modelcontextprotocol)$/i.test(k)) ||
    MCP_RE.test(f.name ?? '')
  ) {
    return 'mcp';
  }
  if (f.npmHasBin === true) return 'cli';
  if (f.npmHasBin === false) return 'library';
  if (topics.includes('cli') || CLI_RE.test(text)) return 'cli';
  if (topics.some((t) => t === 'library' || t === 'sdk' || t === 'framework') || LIB_RE.test(text)) {
    return 'library';
  }
  return 'other';
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

interface GhRepo {
  description: string | null;
  homepage: string | null;
  stargazers_count: number;
  archived: boolean;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  owner?: { login: string; type?: string };
}

interface NpmLatest {
  description?: string;
  bin?: Record<string, string> | string;
  keywords?: string[];
  license?: string;
  repository?: { url?: string } | string;
  author?: { name?: string } | string;
}

/** 公式とみなす発行元。名前の一致だけで決める（偽装は信頼の目印側で防げないので、ここは控えめに） */
const OFFICIAL_OWNERS = new Set([
  'anthropics',
  'openai',
  'google',
  'googleapis',
  'microsoft',
  'vercel',
  'cloudflare',
  'github',
  'aws',
  'awslabs',
  'modelcontextprotocol',
  'getcursor',
  'supabase',
]);

function githubFromNpm(repo: NpmLatest['repository']): string | null {
  const url = typeof repo === 'string' ? repo : repo?.url;
  const m = url ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#]|$)/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 1 件ぶんを調べて、更新した道具を返す。取れなかった項目は元のまま。
 * 入口で種類が確定している（kind が other 以外）ときは、種類だけは上書きしない。
 */
export async function inspectTool(entry: ToolEntry): Promise<ToolEntry> {
  const next: ToolEntry = { ...entry, trust: { ...entry.trust }, inspected: true };
  const facts: KindFacts = { name: entry.name, description: entry.description };

  if (entry.identity.npm) {
    const pkg = encodeURIComponent(entry.identity.npm).replace('%40', '@');
    const meta = await fetchJson<NpmLatest>(`https://registry.npmjs.org/${pkg}/latest`).catch(() => null);
    if (meta) {
      facts.npmHasBin = meta.bin != null && (typeof meta.bin === 'string' || Object.keys(meta.bin).length > 0);
      facts.npmKeywords = meta.keywords ?? [];
      facts.description ??= meta.description ?? null;
      next.description ??= meta.description?.trim() || null;
      next.trust.license ??= meta.license ?? null;
      next.trust.author ??= typeof meta.author === 'string' ? meta.author : (meta.author?.name ?? null);
      const gh = githubFromNpm(meta.repository);
      if (gh && !next.identity.github) next.identity = { ...next.identity, github: gh };
    }
  }

  if (next.identity.github) {
    const [owner] = next.identity.github.split('/');
    const headers = githubHeaders();
    const [repo, contents] = await Promise.all([
      fetchJson<GhRepo>(`https://api.github.com/repos/${next.identity.github}`, { headers }).catch(() => null),
      fetchJson<{ name: string }[]>(`https://api.github.com/repos/${next.identity.github}/contents/`, {
        headers,
      }).catch(() => null),
    ]);
    if (repo) {
      facts.topics = repo.topics ?? [];
      facts.description = facts.description ?? repo.description;
      next.description ??= repo.description?.trim() || null;
      next.trust.stars = repo.stargazers_count;
      next.trust.archived = repo.archived;
      next.trust.license ??= repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null;
      next.trust.author ??= repo.owner?.login ?? owner ?? null;
    }
    if (Array.isArray(contents)) facts.rootFiles = contents.map((c) => c.name);
    if (owner && OFFICIAL_OWNERS.has(owner.toLowerCase())) next.trust.official = true;
  }

  if (entry.kind === 'other') next.kind = classifyKind(facts);
  return next;
}

/**
 * まだ調べていない道具を、予算の範囲で調べる。
 * GitHub は 1 道具 2 リクエスト。Actions の GITHUB_TOKEN（1,000 回/時）なら 100 件でも余裕がある。
 */
export async function inspectPending(
  tools: Record<string, ToolEntry>,
  budget: number,
): Promise<{ tools: Record<string, ToolEntry>; inspected: number }> {
  // 予算に収まらない日は、強い入口で見かけたもの（＝盤面の上に来るもの）から調べる
  const strength = (t: ToolEntry) => Math.max(0, ...t.signals.map((s) => s.strength));
  const pending = Object.values(tools)
    .filter((t) => !t.inspected && t.state !== 'archived' && t.state !== 'passed')
    .sort((a, b) => strength(b) - strength(a) || (a.firstSeen < b.firstSeen ? 1 : -1))
    .slice(0, budget);
  const done = await mapLimit(pending, 6, async (t) => {
    try {
      return await inspectTool(t);
    } catch (err) {
      log.warn(`  道具の調査に失敗: ${t.name}: ${err instanceof Error ? err.message : err}`);
      return { ...t, inspected: true };
    }
  });
  const next = { ...tools };
  for (const t of done) next[t.id] = t;
  return { tools: next, inspected: done.length };
}
