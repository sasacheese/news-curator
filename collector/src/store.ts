import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type { Digest, IndexEntry, Manifest } from './types.js';
import { extractTerms, log, normalizeUrl } from './util.js';

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

/**
 * レーン判定に使う「直近の記憶」を集める。
 *
 * - seenTerms: 過去に一度でも出てきた固有名詞。build レーンはこの補集合を
 *   「初出＝新しい」とみなす。関心キーワードでは新しいものを測れない
 *   （新しいものは、名前がまだ語彙に無いから新しい）ため、履歴で測る。
 * - recentTopicCounts: 直近で何をどれだけ扱ったか。同じテーマの続報を
 *   押し下げるのに使う。seenUrls は URL 一致しか見ないので、同じ話題が
 *   毎日別 URL で来ると素通りしていた。
 */
export async function loadLaneContext(
  beforeDate: string,
  termDays = 60,
  topicDays = 7,
): Promise<{ seenTerms: Set<string>; recentTopicCounts: Map<string, number> }> {
  await ensureDirs();
  const seenTerms = new Set<string>();
  const recentTopicCounts = new Map<string, number>();

  let files: string[] = [];
  try {
    files = (await readdir(INDEX_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return { seenTerms, recentTopicCounts };
  }

  const topicCutoff = shiftDate(beforeDate, -topicDays);
  const termCutoff = shiftDate(beforeDate, -termDays);
  // 月別シャードなので、日数から必要なファイル数を割り出す
  const limit = Math.max(2, Math.ceil(termDays / 30) + 1);

  for (const file of files.slice(0, limit)) {
    const entries = await readJsonOr<IndexEntry[]>(resolve(INDEX_DIR, file), []);
    for (const e of entries) {
      if (e.date >= beforeDate) continue;
      if (e.date >= termCutoff) {
        for (const t of extractTerms(e.title)) seenTerms.add(t);
        for (const k of e.keywords ?? []) {
          for (const t of extractTerms(k)) seenTerms.add(t);
        }
      }
      if (e.date >= topicCutoff) {
        for (const t of e.topics ?? []) {
          recentTopicCounts.set(t, (recentTopicCounts.get(t) ?? 0) + 1);
        }
      }
    }
  }

  return { seenTerms, recentTopicCounts };
}

/** YYYY-MM-DD を日数ぶんずらす */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 直近の日次サマリーを新しい順に返す。
 * 「この先の見立て」を、その日の点ではなく数日の流れから書くために使う。
 * サマリーが無い日（この機能より前の日）は飛ばす。
 */
export async function loadRecentSummaries(
  beforeDate: string,
  days = 7,
): Promise<{ date: string; summary: string[] }[]> {
  await ensureDirs();
  let files: string[] = [];
  try {
    files = (await readdir(DIGEST_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace('.json', ''))
      .filter((d) => d < beforeDate)
      .sort()
      .reverse()
      .slice(0, days);
  } catch {
    return [];
  }

  const result: { date: string; summary: string[] }[] = [];
  for (const date of files) {
    const digest = await readJsonOr<Partial<Digest>>(resolve(DIGEST_DIR, `${date}.json`), {});
    const summary = (digest.summary ?? []).filter(Boolean);
    if (summary.length > 0) result.push({ date, summary });
  }
  return result;
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
    lane: item.lane,
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
    lane: item.lane,
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
    lane: null,
    score: 0,
    publishedAt: item.publishedAt,
    lang: 'unknown',
  }));

  /*
   * 同じ記事が top とリリース情報の両方に載る日がある。ダイジェストの画面は
   * 「ベスト」と「リリース情報」を別枠で見せるので重複してよいが、検索
   * インデックスは 1 記事 1 行でないと同じ記事が二重に並ぶ（React の
   * key も (date, id) なので衝突する）。id で先勝ちにまとめる。
   *
   * 残すのは top > others > releases の順。リリース側は score 0 / rank null /
   * category 固定で、検索結果としては情報が薄い。ただし keyword だけは
   * 製品名とバージョン（v2.1.225 など）を持っていて、これは他のどこにも
   * 出てこない検索語なので、落とす側からも拾っておく。
   */
  const byId = new Map<string, IndexEntry>();
  for (const entry of [...fromTop, ...fromOthers, ...fromReleases]) {
    const kept = byId.get(entry.id);
    if (kept) {
      kept.keywords = [...new Set([...kept.keywords, ...entry.keywords])];
    } else {
      byId.set(entry.id, entry);
    }
  }

  // 並び順は今までどおりに保つ（勝った側だけを元の位置で返す）
  return [...fromTop, ...fromReleases, ...fromOthers].filter((e) => byId.get(e.id) === e);
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
