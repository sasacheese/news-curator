import type { SourcesConfig } from './config.js';
import { fetchFeed } from './rss.js';
import type { AuthorDetail, RawItem, SourceKind } from './types.js';
import {
  detectLang,
  fetchJson,
  fetchText,
  fetchWithRetry,
  hashId,
  jstDateString,
  log,
  mapLimit,
  normalizeUrl,
  safe,
  stripHtml,
  stripMarkdown,
  truncate,
} from './util.js';

export interface Window {
  start: Date;
  end: Date;
}

function inWindow(d: Date | null, w: Window): boolean {
  if (!d) return false;
  const t = d.getTime();
  return t >= w.start.getTime() && t < w.end.getTime();
}

function makeItem(partial: Omit<RawItem, 'id' | 'lang'> & { lang?: RawItem['lang'] }): RawItem {
  const url = normalizeUrl(partial.url);
  return {
    ...partial,
    url,
    id: hashId(partial.source, url),
    lang: partial.lang ?? detectLang(`${partial.title} ${partial.snippet}`),
    snippet: truncate(partial.snippet.replace(/\s+/g, ' ').trim(), 400),
  };
}

/* ------------------------------------------------------------------ *
 * Qiita
 * ------------------------------------------------------------------ */

interface QiitaUser {
  id: string;
  name: string;
  description: string | null;
  organization: string | null;
  location: string | null;
  followers_count: number;
  items_count: number;
  profile_image_url: string | null;
  github_login_name: string | null;
  twitter_screen_name: string | null;
  website_url: string | null;
}

interface QiitaItem {
  id: string;
  title: string;
  url: string;
  body: string;
  created_at: string;
  likes_count: number;
  stocks_count: number;
  comments_count: number;
  tags: { name: string }[];
  user: QiitaUser;
}

function qiitaAuthor(user: QiitaUser | undefined): AuthorDetail | undefined {
  if (!user?.id) return undefined;
  const links: { label: string; url: string }[] = [];
  if (user.github_login_name) {
    links.push({ label: 'GitHub', url: `https://github.com/${user.github_login_name}` });
  }
  if (user.twitter_screen_name) {
    links.push({ label: 'X', url: `https://x.com/${user.twitter_screen_name}` });
  }
  if (user.website_url?.startsWith('http')) {
    links.push({ label: 'Web', url: user.website_url });
  }
  return {
    name: user.name?.trim() || user.id,
    handle: `@${user.id}`,
    url: `https://qiita.com/${user.id}`,
    avatarUrl: user.profile_image_url ?? undefined,
    bio: user.description?.trim() || undefined,
    organization: user.organization?.trim() || undefined,
    location: user.location?.trim() || undefined,
    followers: user.followers_count,
    posts: user.items_count,
    links,
  };
}

async function collectQiita(cfg: SourcesConfig['qiita'], w: Window): Promise<RawItem[]> {
  const since = jstDateString(w.start);
  const headers: Record<string, string> = {};
  if (process.env.QIITA_TOKEN) headers.authorization = `Bearer ${process.env.QIITA_TOKEN}`;

  const out: RawItem[] = [];
  let reachedWindowStart = false;

  for (let page = 1; page <= cfg.maxPages; page++) {
    const url =
      `https://qiita.com/api/v2/items?page=${page}&per_page=${cfg.perPage}` +
      `&query=${encodeURIComponent(`created:>=${since}`)}`;
    const items = await fetchJson<QiitaItem[]>(url, { headers, timeoutMs: 25_000 });
    if (items.length === 0) break;

    let oldestBeforeWindow = false;
    for (const it of items) {
      const created = new Date(it.created_at);
      if (created.getTime() < w.start.getTime()) {
        oldestBeforeWindow = true;
        continue;
      }
      if (!inWindow(created, w)) continue;
      const body = stripMarkdown(it.body ?? '');
      out.push(
        makeItem({
          source: 'qiita',
          sourceLabel: 'Qiita',
          title: it.title,
          url: it.url,
          publishedAt: created.toISOString(),
          author: it.user?.name?.trim() || it.user?.id,
          authorDetail: qiitaAuthor(it.user),
          tags: (it.tags ?? []).map((t) => t.name),
          snippet: body,
          body,
          metrics: {
            likes: it.likes_count,
            stocks: it.stocks_count,
            comments: it.comments_count,
          },
          sourceWeight: 3,
          lang: 'ja',
        }),
      );
    }
    // 作成日時降順で返るので、ウィンドウより古いものが出てきたら以降は不要
    if (oldestBeforeWindow) {
      reachedWindowStart = true;
      break;
    }
  }

  if (!reachedWindowStart) {
    log.warn(
      `qiita: ${cfg.maxPages} ページではウィンドウ開始まで遡れませんでした（取りこぼしの可能性あり）`,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Zenn
 * ------------------------------------------------------------------ */

interface ZennArticle {
  id: number;
  slug: string;
  title: string;
  path: string;
  published_at: string;
  liked_count: number;
  bookmarked_count: number;
  comments_count: number;
  article_type: string;
  body_letters_count: number;
  user?: { username?: string; name?: string; avatar_small_url?: string };
  publication?: { name?: string; display_name?: string; avatar_small_url?: string } | null;
}

function zennAuthor(a: ZennArticle): AuthorDetail | undefined {
  const u = a.user;
  if (!u?.username) return undefined;
  return {
    name: u.name?.trim() || u.username,
    handle: `@${u.username}`,
    url: `https://zenn.dev/${u.username}`,
    avatarUrl: u.avatar_small_url,
    organization: a.publication?.display_name ?? undefined,
    links: a.publication?.name
      ? [{ label: 'Publication', url: `https://zenn.dev/p/${a.publication.name}` }]
      : [],
  };
}

async function collectZenn(cfg: SourcesConfig['zenn'], w: Window): Promise<RawItem[]> {
  const byUrl = new Map<string, RawItem>();
  for (const order of cfg.orders) {
    const res = await safe(
      `zenn(${order})`,
      () =>
        fetchJson<{ articles: ZennArticle[] }>(
          `https://zenn.dev/api/articles?order=${encodeURIComponent(order)}&count=${cfg.count}`,
        ),
      { articles: [] as ZennArticle[] },
    );
    for (const a of res.articles ?? []) {
      const published = new Date(a.published_at);
      if (!inWindow(published, w)) continue;
      const url = `https://zenn.dev${a.path}`;
      const item = makeItem({
        source: 'zenn',
        sourceLabel: a.publication?.display_name ? `Zenn / ${a.publication.display_name}` : 'Zenn',
        title: a.title,
        url,
        publishedAt: published.toISOString(),
        author: a.user?.name ?? a.user?.username,
        authorDetail: zennAuthor(a),
        tags: [a.article_type].filter(Boolean),
        snippet: '',
        metrics: {
          likes: a.liked_count,
          stocks: a.bookmarked_count,
          comments: a.comments_count,
        },
        sourceWeight: 3,
        lang: 'ja',
      });
      byUrl.set(item.url, item);
    }
  }
  return [...byUrl.values()];
}

/** GitHub リポジトリの README を取得する（リポジトリページを HTML で取ると UI 部品が混ざるため） */
export async function fetchGithubReadme(repoUrl: string): Promise<string> {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl);
  if (!m) return '';
  const res = await fetchWithRetry(`https://api.github.com/repos/${m[1]}/${m[2]}/readme`, {
    headers: { ...githubHeaders(), accept: 'application/vnd.github.raw+json' },
  });
  if (!res.ok) return '';
  return stripMarkdown(await res.text());
}

/** Zenn は本文を個別 API で取得する */
export async function fetchZennBody(url: string): Promise<string> {
  const slug = url.split('/').pop();
  if (!slug) return '';
  const res = await fetchJson<Record<string, unknown>>(
    `https://zenn.dev/api/articles/${encodeURIComponent(slug)}`,
  );
  const article = (res.article ?? res) as Record<string, unknown>;
  const html = String(article.body_html ?? '');
  return stripHtml(html);
}

/* ------------------------------------------------------------------ *
 * はてなブックマーク
 * ------------------------------------------------------------------ */

async function collectHatena(cfg: SourcesConfig['hatena'], w: Window): Promise<RawItem[]> {
  const byUrl = new Map<string, RawItem>();
  for (const feed of cfg.feeds) {
    const entries = await safe(`hatena(${feed})`, () => fetchFeed(feed), []);
    for (const e of entries) {
      if (!inWindow(e.publishedAt, w)) continue;
      const item = makeItem({
        source: 'hatena',
        sourceLabel: 'はてなブックマーク',
        title: e.title,
        url: e.link,
        publishedAt: (e.publishedAt ?? new Date()).toISOString(),
        author: e.author,
        authorDetail: e.author ? { name: e.author } : undefined,
        tags: e.tags,
        snippet: e.summary || e.content,
        metrics: {},
        sourceWeight: 3,
      });
      byUrl.set(item.url, item);
    }
  }
  return [...byUrl.values()];
}

/** はてなブックマーク数を一括取得（50件ずつ） */
export async function fetchHatenaCounts(urls: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 40) chunks.push(urls.slice(i, i + 40));

  await mapLimit(chunks, 3, async (chunk) => {
    const qs = chunk.map((u) => `url=${encodeURIComponent(u)}`).join('&');
    const res = await safe(
      'hatena-count',
      () => fetchJson<Record<string, number>>(`https://bookmark.hatenaapis.com/count/entries?${qs}`),
      {},
    );
    for (const [url, count] of Object.entries(res)) result.set(url, count);
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Hacker News (Algolia)
 * ------------------------------------------------------------------ */

interface HnHit {
  objectID: string;
  title: string | null;
  url: string | null;
  story_text?: string | null;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  author: string;
  _tags?: string[];
}

async function collectHackerNews(cfg: SourcesConfig['hackernews'], w: Window): Promise<RawItem[]> {
  const from = Math.floor(w.start.getTime() / 1000);
  const to = Math.floor(w.end.getTime() / 1000);
  const filters = `created_at_i>${from},created_at_i<${to},points>${cfg.minPoints}`;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=story` +
    `&numericFilters=${encodeURIComponent(filters)}&hitsPerPage=${cfg.hitsPerPage}`;
  const res = await fetchJson<{ hits: HnHit[] }>(url);

  return (res.hits ?? [])
    .filter((h) => h.title)
    .map((h) =>
      makeItem({
        source: 'hackernews',
        sourceLabel: 'Hacker News',
        title: h.title!,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        publishedAt: new Date(h.created_at_i * 1000).toISOString(),
        author: h.author,
        authorDetail: h.author
          ? {
              name: h.author,
              handle: h.author,
              url: `https://news.ycombinator.com/user?id=${encodeURIComponent(h.author)}`,
            }
          : undefined,
        tags: [],
        snippet: stripHtml(h.story_text ?? ''),
        metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
        sourceWeight: 3,
        lang: 'en',
      }),
    );
}

/* ------------------------------------------------------------------ *
 * dev.to
 * ------------------------------------------------------------------ */

interface DevtoArticle {
  title: string;
  url: string;
  description: string;
  published_at: string;
  positive_reactions_count: number;
  comments_count: number;
  tag_list: string[];
  user: {
    name: string;
    username?: string;
    twitter_username?: string | null;
    github_username?: string | null;
    website_url?: string | null;
    profile_image?: string | null;
  };
}

function devtoAuthor(u: DevtoArticle['user'] | undefined): AuthorDetail | undefined {
  if (!u?.name && !u?.username) return undefined;
  const links: { label: string; url: string }[] = [];
  if (u.github_username) links.push({ label: 'GitHub', url: `https://github.com/${u.github_username}` });
  if (u.twitter_username) links.push({ label: 'X', url: `https://x.com/${u.twitter_username}` });
  if (u.website_url?.startsWith('http')) links.push({ label: 'Web', url: u.website_url });
  return {
    name: u.name || u.username!,
    handle: u.username ? `@${u.username}` : undefined,
    url: u.username ? `https://dev.to/${u.username}` : undefined,
    avatarUrl: u.profile_image ?? undefined,
    links,
  };
}

async function collectDevto(cfg: SourcesConfig['devto'], w: Window): Promise<RawItem[]> {
  const res = await fetchJson<DevtoArticle[]>(
    `https://dev.to/api/articles?top=2&per_page=${cfg.perPage}`,
  );
  return (res ?? [])
    .filter((a) => a.positive_reactions_count >= cfg.minReactions)
    .filter((a) => inWindow(new Date(a.published_at), w))
    .map((a) =>
      makeItem({
        source: 'devto',
        sourceLabel: 'dev.to',
        title: a.title,
        url: a.url,
        publishedAt: new Date(a.published_at).toISOString(),
        author: a.user?.name,
        authorDetail: devtoAuthor(a.user),
        tags: a.tag_list ?? [],
        snippet: a.description ?? '',
        metrics: { likes: a.positive_reactions_count, comments: a.comments_count },
        sourceWeight: 2,
        lang: 'en',
      }),
    );
}

/* ------------------------------------------------------------------ *
 * GitHub Releases
 * ------------------------------------------------------------------ */

interface GhRelease {
  html_url: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  author?: { login: string; html_url: string; avatar_url: string } | null;
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** 1 リポジトリあたりに取るリリース件数。1 ページで済む範囲で最大に寄せている */
const RELEASES_PER_PAGE = 100;

async function collectGithubReleases(
  cfg: SourcesConfig['githubReleases'],
  w: Window,
): Promise<RawItem[]> {
  const headers = githubHeaders();
  const nested = await mapLimit(cfg.repos, 6, async (repo) =>
    safe(
      `gh-release(${repo})`,
      async () => {
        /**
         * per_page は多めに取る。リクエスト数は 1 ページなら同じで、
         * モノレポは 1 日に 10 件以上リリースすることがあるため。
         * 実測で cloudflare/workers-sdk が 1 日 10 パッケージ出しており、
         * per_page=10 だとウィンドウ内のリリースが新しいものに押し出されて
         * 静かに落ちていた（実行が数時間ずれるだけで件数が変わる）。
         */
        const releases = await fetchJson<GhRelease[]>(
          `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`,
          { headers },
        );

        // 取りこぼしは黙って起きるので、遡れなかったときは気づけるようにする
        const oldest = releases.reduce<number | null>((min, r) => {
          const t = r.published_at ? new Date(r.published_at).getTime() : null;
          return t === null ? min : min === null ? t : Math.min(min, t);
        }, null);
        if (
          releases.length >= RELEASES_PER_PAGE &&
          oldest !== null &&
          oldest >= w.start.getTime()
        ) {
          log.warn(
            `gh-release(${repo}): ${RELEASES_PER_PAGE} 件ではウィンドウ開始まで遡れませんでした（取りこぼしの可能性あり）`,
          );
        }

        return releases
          .filter((r) => !r.draft)
          .filter((r) => cfg.includePrerelease || !r.prerelease)
          .filter((r) => inWindow(r.published_at ? new Date(r.published_at) : null, w))
          .map((r) => {
            const body = stripMarkdown(r.body ?? '');
            return makeItem({
              source: 'github_release',
              sourceLabel: `GitHub Releases / ${repo}`,
              title: `${repo} ${r.name?.trim() || r.tag_name}`,
              url: r.html_url,
              publishedAt: new Date(r.published_at!).toISOString(),
              author: r.author?.login,
              authorDetail: r.author?.login
                ? {
                    name: r.author.login,
                    handle: `@${r.author.login}`,
                    url: r.author.html_url,
                    avatarUrl: r.author.avatar_url,
                    organization: repo.split('/')[0],
                  }
                : undefined,
              tags: [repo.split('/')[1] ?? repo, 'release'],
              snippet: body,
              body,
              metrics: {},
              sourceWeight: 5,
              lang: 'en',
            });
          });
      },
      [] as RawItem[],
    ),
  );
  return nested.flat();
}

/* ------------------------------------------------------------------ *
 * GitHub 新着トレンドリポジトリ
 * ------------------------------------------------------------------ */

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
  pushed_at: string;
  language: string | null;
  topics?: string[];
}

async function collectGithubTrending(
  cfg: SourcesConfig['githubTrending'],
  w: Window,
): Promise<RawItem[]> {
  const headers = githubHeaders();
  // 「直近 21 日以内に作られて、もう N スター付いている」= 実質的な急上昇枠
  const since = jstDateString(new Date(w.end.getTime() - 21 * 24 * 60 * 60 * 1000));
  const nested = await mapLimit(cfg.queries, 2, async (q) =>
    safe(
      `gh-trending(${q})`,
      async () => {
        const query = `${q} created:>=${since} stars:>=${cfg.minStars}`;
        const res = await fetchJson<{ items: GhRepo[] }>(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
            `&sort=stars&order=desc&per_page=${cfg.perPage}`,
          { headers },
        );
        return (res.items ?? []).map((r) =>
          makeItem({
            source: 'github_repo',
            sourceLabel: 'GitHub 急上昇リポジトリ',
            title: `${r.full_name} — ${r.description ?? ''}`.trim(),
            url: r.html_url,
            // 「新着」の起点は作成日だが、ウィンドウ判定からは外して seen 判定で重複排除する
            publishedAt: new Date(r.created_at).toISOString(),
            author: r.full_name.split('/')[0],
            authorDetail: {
              name: r.full_name.split('/')[0] ?? r.full_name,
              url: `https://github.com/${r.full_name.split('/')[0]}`,
              avatarUrl: `https://github.com/${r.full_name.split('/')[0]}.png?size=120`,
              bio: r.description ?? undefined,
            },
            tags: [r.language, ...(r.topics ?? [])].filter((t): t is string => Boolean(t)).slice(0, 8),
            snippet: r.description ?? '',
            metrics: { stars: r.stargazers_count },
            sourceWeight: 3,
            lang: 'en',
          }),
        );
      },
      [] as RawItem[],
    ),
  );
  return nested.flat();
}

/* ------------------------------------------------------------------ *
 * RSS
 * ------------------------------------------------------------------ */

async function collectRss(cfg: SourcesConfig['rss'], w: Window): Promise<RawItem[]> {
  const nested = await mapLimit(cfg.feeds, 6, async (feed) =>
    safe(
      `rss(${feed.label})`,
      async () => {
        const entries = await fetchFeed(feed.url);
        return entries
          .filter((e) => inWindow(e.publishedAt, w))
          .map((e) =>
            makeItem({
              source: 'rss',
              sourceLabel: feed.label,
              title: e.title,
              url: e.link,
              publishedAt: e.publishedAt!.toISOString(),
              author: e.author,
              authorDetail: e.author ? { name: e.author } : undefined,
              tags: e.tags,
              snippet: e.summary || e.content,
              body: e.content.length > 400 ? e.content : undefined,
              metrics: {},
              sourceWeight: feed.weight,
            }),
          );
      },
      [] as RawItem[],
    ),
  );
  return nested.flat();
}

/* ------------------------------------------------------------------ *
 * CHANGELOG（raw Markdown の先頭セクションを拾う）
 * ------------------------------------------------------------------ */

async function collectChangelogs(cfg: SourcesConfig['changelogs'], w: Window): Promise<RawItem[]> {
  const nested = await mapLimit(cfg.entries, 3, async (entry) =>
    safe(
      `changelog(${entry.label})`,
      async () => {
        const md = await fetchText(entry.url);
        const lines = md.split('\n');
        const headingIdx = lines.findIndex((l) => /^#{1,3}\s+\S/.test(l) && !/^#\s/.test(l));
        if (headingIdx === -1) return [] as RawItem[];

        const heading = lines[headingIdx]!.replace(/^#+\s*/, '').trim();
        const rest = lines.slice(headingIdx + 1);
        const nextIdx = rest.findIndex((l) => /^#{1,3}\s+\S/.test(l));
        const bodyRaw = (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).join('\n');
        const body = stripMarkdown(bodyRaw);
        if (!body) return [] as RawItem[];

        const version = heading.replace(/[^\w.\-]/g, '');
        return [
          makeItem({
            source: 'changelog',
            sourceLabel: entry.label,
            title: `${entry.label} ${heading}`,
            url: `${entry.homepage}#${version || 'latest'}`,
            publishedAt: w.end.toISOString(),
            tags: ['changelog'],
            snippet: body,
            body,
            metrics: {},
            sourceWeight: 5,
            lang: 'en',
          }),
        ];
      },
      [] as RawItem[],
    ),
  );
  return nested.flat();
}

/* ------------------------------------------------------------------ *
 * エントリポイント
 * ------------------------------------------------------------------ */

type Collector = { name: SourceKind | string; run: () => Promise<RawItem[]> };

export async function collectAll(cfg: SourcesConfig, w: Window): Promise<RawItem[]> {
  const collectors: Collector[] = [];

  if (cfg.qiita.enabled) collectors.push({ name: 'qiita', run: () => collectQiita(cfg.qiita, w) });
  if (cfg.zenn.enabled) collectors.push({ name: 'zenn', run: () => collectZenn(cfg.zenn, w) });
  if (cfg.hatena.enabled)
    collectors.push({ name: 'hatena', run: () => collectHatena(cfg.hatena, w) });
  if (cfg.hackernews.enabled)
    collectors.push({ name: 'hackernews', run: () => collectHackerNews(cfg.hackernews, w) });
  if (cfg.devto.enabled) collectors.push({ name: 'devto', run: () => collectDevto(cfg.devto, w) });
  if (cfg.githubReleases.enabled)
    collectors.push({
      name: 'github_release',
      run: () => collectGithubReleases(cfg.githubReleases, w),
    });
  if (cfg.githubTrending.enabled)
    collectors.push({
      name: 'github_repo',
      run: () => collectGithubTrending(cfg.githubTrending, w),
    });
  if (cfg.rss.enabled) collectors.push({ name: 'rss', run: () => collectRss(cfg.rss, w) });
  if (cfg.changelogs.enabled)
    collectors.push({ name: 'changelog', run: () => collectChangelogs(cfg.changelogs, w) });

  const results = await Promise.all(
    collectors.map(async (c) => {
      const items = await safe(`collect(${c.name})`, c.run, [] as RawItem[]);
      log.info(`  ${String(c.name).padEnd(15)} ${String(items.length).padStart(4)} 件`);
      return items;
    }),
  );

  return results.flat();
}
