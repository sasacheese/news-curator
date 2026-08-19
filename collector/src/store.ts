import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type {
  CommunityBoard,
  Digest,
  IndexEntry,
  Manifest,
  TrendBoard,
  TrendDay,
  TrendShard,
} from './types.js';
import { log, normalizeUrl } from './util.js';

const DIGEST_DIR = resolve(DATA_DIR, 'digests');
const INDEX_DIR = resolve(DATA_DIR, 'index');
const MANIFEST_PATH = resolve(DATA_DIR, 'manifest.json');
/** コミュニティの盤面。日付を持たない 1 ファイルで、毎回差し替える */
const COMMUNITY_PATH = resolve(DATA_DIR, 'community.json');
/**
 * 話題台帳とトレンドの盤面。
 *
 * 台帳は data/index と同じ月別シャード（過去月は書き換わらない）。盤面は
 * コミュニティと同じく日付を持たない 1 ファイルで、毎回まるごと差し替える。
 */
const TREND_DIR = resolve(DATA_DIR, 'trends');
const TREND_BOARD_PATH = resolve(TREND_DIR, 'board.json');

async function ensureDirs(): Promise<void> {
  await mkdir(DIGEST_DIR, { recursive: true });
  await mkdir(INDEX_DIR, { recursive: true });
  await mkdir(TREND_DIR, { recursive: true });
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

/**
 * 前回の盤面に載っていた id を集める。
 *
 * イベントは開催まで毎日盤面に居るのが正しいので、記事のように重複排除で
 * 落とすことはしない。代わりに「前回に無かったもの」へ印を付けるために使う。
 * 毎日同じ盤面を眺めることになるので、差分が見えるかどうかがこの画面の
 * 読みやすさを決める。
 *
 * 見るのは 1 世代前だけ。履歴を持たないので、これ以上は遡れない
 * （遡れたとしても、数日前に見たものが NEW のまま残るだけで役に立たない）。
 */
export async function loadPreviousCommunityIds(): Promise<Set<string>> {
  await ensureDirs();
  const board = await readJsonOr<Partial<CommunityBoard>>(COMMUNITY_PATH, {});
  return new Set((board.items ?? []).map((c) => c.id));
}

/**
 * 盤面をまるごと差し替える。
 *
 * 日次ダイジェストのように日付ごとには残さない。開催が過ぎたイベントに価値は無く、
 * 同じ 12 件が毎日コミットされるだけになるため。
 */
export async function saveCommunityBoard(board: CommunityBoard): Promise<void> {
  await ensureDirs();
  await writeJson(COMMUNITY_PATH, board);
  const counts = Object.entries(board.byAction)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  log.info(`保存: data/community.json (${board.items.length} 件 — ${counts})`);
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
    summary: item.oneLiner,
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

/* ------------------------------------------------------------------ *
 * 話題台帳（トレンド）
 * ------------------------------------------------------------------ */

/**
 * 直近 N 日ぶんの掲載記事を新しい順に返す。
 *
 * トレンドの語彙（LLM が付けた keywords）とタイムライン（掲載済みの記事）の
 * 両方に使う。月別シャードなので、日数ぶんをカバーする最小の枚数だけ読む。
 */
export async function loadRecentIndexEntries(date: string, days: number): Promise<IndexEntry[]> {
  await ensureDirs();
  const from = shiftDate(date, -(days - 1));
  let files: string[] = [];
  try {
    files = (await readdir(INDEX_DIR))
      .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .filter((f) => f.replace('.json', '') >= from.slice(0, 7))
      .sort();
  } catch {
    return [];
  }

  const entries: IndexEntry[] = [];
  for (const file of files) {
    const shard = await readJsonOr<IndexEntry[]>(resolve(INDEX_DIR, file), []);
    for (const entry of shard) {
      if (entry.date >= from && entry.date <= date) entries.push(entry);
    }
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return entries;
}

function trendShardPath(month: string): string {
  return resolve(TREND_DIR, `${month}.json`);
}

/** YYYY-MM-DD の月をひとつ前にずらす */
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/**
 * 台帳を読む。保持期間（28 日）は月をまたぐので、当月と前月の 2 シャードで足りる。
 * 表示名は日ごとに持たないので、2 つのシャードのぶんを合わせて返す。
 */
export async function loadTrendLedger(
  date: string,
): Promise<{ days: TrendDay[]; labels: Record<string, string> }> {
  await ensureDirs();
  const month = date.slice(0, 7);
  const shards = await Promise.all(
    [previousMonth(month), month].map((m) =>
      readJsonOr<Partial<TrendShard>>(trendShardPath(m), {}),
    ),
  );
  const days: TrendDay[] = [];
  let labels: Record<string, string> = {};
  for (const shard of shards) {
    days.push(...(shard.days ?? []));
    labels = { ...labels, ...(shard.labels ?? {}) };
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days, labels };
}

/**
 * 台帳を月別シャードへ書き戻す。
 *
 * 保持期間の外に出た日はシャードから消す。過去月のシャードは、そこに残る日が
 * 無くなるまで（＝月が変わって 28 日経つまで）書き換わり続ける。
 */
export async function saveTrendLedger(
  days: readonly TrendDay[],
  labels: Readonly<Record<string, string>>,
): Promise<void> {
  await ensureDirs();
  const byMonth = new Map<string, TrendDay[]>();
  for (const day of days) {
    const month = day.date.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(day);
    byMonth.set(month, list);
  }

  for (const [month, monthDays] of byMonth) {
    // その月に残る日で使われている表示名だけを持たせる
    const keys = new Set<string>();
    for (const day of monthDays) for (const key of Object.keys(day.counts)) keys.add(key);
    const shardLabels: Record<string, string> = {};
    for (const key of keys) if (labels[key]) shardLabels[key] = labels[key]!;
    await writeJson(trendShardPath(month), { labels: shardLabels, days: monthDays });
  }

  const total = days.reduce((sum, d) => sum + Object.keys(d.counts).length, 0);
  log.info(`保存: data/trends/*.json (${days.length} 日 / 話題 ${total} 件)`);
}

/**
 * 盤面をまるごと差し替える。
 *
 * 日次ダイジェストのように日付ごとには残さない。トレンドは「いまの状態」なので、
 * 3 か月後にその日を開いた人に当時の盤面を見せても嘘になる。
 */
export async function saveTrendBoard(board: TrendBoard): Promise<void> {
  await ensureDirs();
  await writeJson(TREND_BOARD_PATH, board);
  log.info(
    `保存: data/trends/board.json (動いた ${board.hot.length} / 追跡 ${board.keep.length} / 落ち着き ${board.cool.length})`,
  );
}
