import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TopicsConfig, Watchlist } from './types.js';
import { log } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
export const CONFIG_DIR = resolve(REPO_ROOT, 'config');
export const DATA_DIR = resolve(REPO_ROOT, 'data');

export interface SourcesConfig {
  qiita: { enabled: boolean; maxPages: number; perPage: number };
  zenn: { enabled: boolean; orders: string[]; count: number };
  hatena: { enabled: boolean; feeds: string[] };
  hackernews: { enabled: boolean; minPoints: number; hitsPerPage: number };
  devto: { enabled: boolean; perPage: number; minReactions: number };
  githubReleases: { enabled: boolean; repos: string[]; includePrerelease: boolean };
  githubTrending: { enabled: boolean; minStars: number; perPage: number; queries: string[] };
  rss: { enabled: boolean; feeds: { label: string; url: string; weight: number }[] };
  changelogs: { enabled: boolean; entries: { label: string; url: string; homepage: string }[] };
}

/** sources.json の「監視対象リスト抜き」の形。リストは watchlist.json から合流させる。 */
type SourcesFile = Omit<SourcesConfig, 'githubReleases' | 'rss' | 'changelogs'> & {
  githubReleases: Omit<SourcesConfig['githubReleases'], 'repos'>;
  rss: Omit<SourcesConfig['rss'], 'feeds'>;
  changelogs: Omit<SourcesConfig['changelogs'], 'entries'>;
};

/** 実行時のチューニング項目。すべて環境変数で上書きできる。 */
export interface RuntimeConfig {
  /** 事前スコアリング後に LLM へ渡す候補数 */
  rankCandidates: number;
  /** 深掘り要約する件数（= ベスト N） */
  topN: number;
  /** 「その他の注目記事」として保存する件数 */
  otherN: number;
  rankModel: string;
  summaryModel: string;
  summaryEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 深掘り時に LLM へ渡す本文の最大文字数 */
  bodyCharLimit: number;
  /** ランキング 1 リクエストあたりのアイテム数 */
  rankBatchSize: number;
  cutoffHour: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const effort = str('SUMMARY_EFFORT', 'medium') as RuntimeConfig['summaryEffort'];
  return {
    /**
     * LLM に採点させる候補数。
     *
     * 採点は 2 段階（スコアのみ → 上位だけ文章化）なので、ここを増やして
     * 増えるのは安い 1 段目の入力だけ。2 段目と深掘りのコストは変わらない。
     * 150 件でも採点コストは 2 段階化前の 90 件より安く収まる。
     *
     * 逆に絞る方向は割に合わない。45 まで下げる案を実データで検証したところ、
     * 46〜60 位の帯に「実際にベスト3入りした記事」が含まれていた。
     */
    rankCandidates: num('RANK_CANDIDATES', 150),
    /**
     * 深掘りする件数。AI / AI以外 の**グループごと**なので、既定 2 で 4 件。
     * 深掘りは Sonnet を使う一番高い工程で、実測でも全体の 6〜7 割を占める。
     * 3 にすると 6 件になり 1 日あたり $0.12 ほど増える。
     * 読了目安も 3 なら 36 分で「30分でキャッチアップ」を超える。
     */
    topN: num('TOP_N', 2),
    otherN: num('OTHER_N', 12),
    rankModel: str('RANK_MODEL', 'claude-haiku-4-5'),
    summaryModel: str('SUMMARY_MODEL', 'claude-sonnet-5'),
    summaryEffort: (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(effort)
      ? effort
      : 'medium',
    bodyCharLimit: num('BODY_CHAR_LIMIT', 12_000),
    rankBatchSize: num('RANK_BATCH_SIZE', 18),
    cutoffHour: num('CUTOFF_HOUR', 7),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadTopics(): Promise<TopicsConfig> {
  const raw = await readJson<TopicsConfig & { $comment?: string }>(
    resolve(CONFIG_DIR, 'topics.json'),
  );
  return {
    profile: raw.profile ?? '',
    topics: (raw.topics ?? []).filter((t) => t?.name).map((t) => ({
      name: t.name,
      weight: Number.isFinite(t.weight) ? t.weight : 3,
      keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
    })),
    exclude: { keywords: (raw.exclude?.keywords ?? []).map((k) => k.toLowerCase()) },
  };
}

/**
 * 監視対象リストを読む。
 *
 * このファイルは GitHub の Web エディタから手で編集される前提なので、
 * 書式を外した項目は落として警告するだけにとどめる。1 行の typo で
 * その日の収集が丸ごと止まる方が損失が大きい。
 */
export async function loadWatchlist(): Promise<Watchlist> {
  const raw = await readJson<Partial<Watchlist>>(resolve(CONFIG_DIR, 'watchlist.json'));
  const dropped: string[] = [];

  const repos = uniqueBy(
    asArray(raw.repos).filter((r) => {
      const ok = typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.trim());
      if (!ok) dropped.push(`repos: ${JSON.stringify(r)}`);
      return ok;
    }).map((r) => r.trim()),
    (r) => r.toLowerCase(),
  );

  const feeds = uniqueBy(
    asArray(raw.feeds).flatMap((f) => {
      if (!f || typeof f !== 'object' || !isHttpUrl(f.url) || !f.label?.trim()) {
        dropped.push(`feeds: ${JSON.stringify(f)}`);
        return [];
      }
      const weight = Number(f.weight);
      return [
        {
          label: f.label.trim(),
          url: f.url.trim(),
          weight: Number.isFinite(weight) ? clamp(weight, 1, 5) : 3,
        },
      ];
    }),
    (f) => normalizeKey(f.url),
  );

  const changelogs = uniqueBy(
    asArray(raw.changelogs).flatMap((c) => {
      if (!c || typeof c !== 'object' || !isHttpUrl(c.url) || !c.label?.trim()) {
        dropped.push(`changelogs: ${JSON.stringify(c)}`);
        return [];
      }
      return [
        {
          label: c.label.trim(),
          url: c.url.trim(),
          homepage: isHttpUrl(c.homepage) ? c.homepage.trim() : c.url.trim(),
        },
      ];
    }),
    (c) => normalizeKey(c.url),
  );

  if (dropped.length > 0) {
    log.warn(
      `watchlist.json の ${dropped.length} 件を書式不正としてスキップしました: ${dropped.join(', ')}`,
    );
  }
  log.info(
    `監視対象: リポジトリ ${repos.length} / フィード ${feeds.length} / CHANGELOG ${changelogs.length}`,
  );
  return { repos, feeds, changelogs };
}

export async function loadSources(): Promise<SourcesConfig> {
  const [file, watchlist] = await Promise.all([
    readJson<SourcesFile>(resolve(CONFIG_DIR, 'sources.json')),
    loadWatchlist(),
  ]);
  return {
    ...file,
    githubReleases: { ...file.githubReleases, repos: watchlist.repos },
    rss: { ...file.rss, feeds: watchlist.feeds },
    changelogs: { ...file.changelogs, entries: watchlist.changelogs },
  };
}

function asArray<T>(v: T[] | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 末尾スラッシュだけ違う重複を拾うための正規化 */
function normalizeKey(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
