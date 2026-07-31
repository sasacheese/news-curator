import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TopicsConfig } from './types.js';

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
     * 45 まで絞るとコストは月 ¥80 ほど下がるが、実データで検証したところ
     * 46〜60 位の帯に「実際にベスト3入りした記事」が含まれていた。
     * 削減幅に対してリスクが大きすぎるので 90 のままにしている。
     *
     * 採点は 2 段階（スコアのみ → 上位だけ文章化）なので、ここを増やしても
     * 増えるのは安い 1 段目の入力だけ。カバー範囲を広げたいなら上げてよい。
     */
    rankCandidates: num('RANK_CANDIDATES', 90),
    topN: num('TOP_N', 3),
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

export async function loadSources(): Promise<SourcesConfig> {
  return await readJson<SourcesConfig>(resolve(CONFIG_DIR, 'sources.json'));
}
