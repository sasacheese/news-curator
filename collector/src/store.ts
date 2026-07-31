import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type { Digest, IndexEntry, Manifest } from './types.js';
import { log, normalizeUrl } from './util.js';

const DIGEST_DIR = resolve(DATA_DIR, 'digests');
const INDEX_DIR = resolve(DATA_DIR, 'index');
const MANIFEST_PATH = resolve(DATA_DIR, 'manifest.json');

async function ensureDirs(): Promise<void> {
  await mkdir(DIGEST_DIR, { recursive: true });
  await mkdir(INDEX_DIR, { recursive: true });
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 過去に一度でもダイジェストに載った URL を集める。
 * 同じ記事が翌日以降に再浮上するのを防ぐために使う。
 */
export async function loadSeenUrls(days = 90): Promise<Set<string>> {
  await ensureDirs();
  const seen = new Set<string>();
  let files: string[] = [];
  try {
    files = (await readdir(INDEX_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return seen;
  }

  // 月別シャードなので、直近 4 ファイル（≒最大 4 か月）読めば 90 日分をカバーできる
  const limit = Math.max(2, Math.ceil(days / 30) + 1);
  for (const file of files.slice(0, limit)) {
    const entries = await readJsonOr<IndexEntry[]>(resolve(INDEX_DIR, file), []);
    for (const e of entries) seen.add(normalizeUrl(e.url));
  }
  return seen;
}

export function toIndexEntries(digest: Digest): IndexEntry[] {
  const fromTop = digest.top.map<IndexEntry>((item) => ({
    id: item.id,
    date: digest.date,
    rank: item.rank,
    title: item.title,
    url: item.url,
    source: item.source,
    sourceLabel: item.sourceLabel,
    summary: item.deep.headline || item.oneLiner,
    keywords: item.keywords,
    topics: item.matchedTopics,
    category: item.category,
    score: item.score,
    publishedAt: item.publishedAt,
    lang: item.lang,
  }));

  const fromOthers = digest.others.map<IndexEntry>((item) => ({
    id: item.id,
    date: digest.date,
    rank: null,
    title: item.title,
    url: item.url,
    source: item.source,
    sourceLabel: item.sourceLabel,
    summary: item.oneLiner,
    keywords: item.keywords,
    topics: item.matchedTopics,
    category: item.category,
    score: item.score,
    publishedAt: item.publishedAt,
    lang: item.lang,
  }));

  // リリース情報も後から「あれ何だっけ」で引けるようにインデックスへ入れる
  const fromReleases = (digest.releases ?? []).map<IndexEntry>((item) => ({
    id: item.id,
    date: digest.date,
    rank: null,
    title: item.title,
    url: item.url,
    source: 'github_release',
    sourceLabel: item.sourceLabel,
    summary: item.summary,
    keywords: [item.product, item.version].filter((v): v is string => Boolean(v)),
    topics: [],
    category: 'リリース/アップデート',
    score: 0,
    publishedAt: item.publishedAt,
    lang: 'unknown',
  }));

  return [...fromTop, ...fromReleases, ...fromOthers];
}

export async function saveDigest(digest: Digest): Promise<void> {
  await ensureDirs();

  // 1) 日次ダイジェスト
  await writeJson(resolve(DIGEST_DIR, `${digest.date}.json`), digest);

  // 2) 月別検索インデックス（同じ日付の分は入れ替える）
  const month = digest.date.slice(0, 7);
  const indexPath = resolve(INDEX_DIR, `${month}.json`);
  const existing = await readJsonOr<IndexEntry[]>(indexPath, []);
  const merged = [
    ...existing.filter((e) => e.date !== digest.date),
    ...toIndexEntries(digest),
  ].sort((a, b) => (a.date === b.date ? b.score - a.score : b.date.localeCompare(a.date)));
  await writeJson(indexPath, merged);

  // 3) マニフェスト
  const dates = (await readdir(DIGEST_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort()
    .reverse();
  const months = (await readdir(INDEX_DIR))
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort()
    .reverse();

  // ローカル実行では GITHUB_REPOSITORY が無いので、既知の値を null で上書きしない
  const previous = await readJsonOr<Partial<Manifest>>(MANIFEST_PATH, {});
  const manifest: Manifest = {
    updatedAt: new Date().toISOString(),
    latest: dates[0] ?? null,
    dates,
    months,
    repo: process.env.GITHUB_REPOSITORY?.trim() || previous.repo || null,
  };
  await writeJson(MANIFEST_PATH, manifest);

  log.info(`保存: data/digests/${digest.date}.json`);
  log.info(`保存: data/index/${month}.json (${merged.length} 件)`);
  log.info(`保存: data/manifest.json (${dates.length} 日分)`);
}
