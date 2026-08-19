import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type {
  CommunityBoard,
  Digest,
  IndexEntry,
  Manifest,
  RadarBoard,
  RadarLedgerEntry,
} from './types.js';
import { log, normalizeUrl } from './util.js';

const DIGEST_DIR = resolve(DATA_DIR, 'digests');
const INDEX_DIR = resolve(DATA_DIR, 'index');
const MANIFEST_PATH = resolve(DATA_DIR, 'manifest.json');
/** コミュニティの盤面。日付を持たない 1 ファイルで、毎回差し替える */
const COMMUNITY_PATH = resolve(DATA_DIR, 'community.json');
/** 発掘の盤面。ブラウザが読む。コミュニティ盤面と同じ扱い */
const RADAR_PATH = resolve(DATA_DIR, 'radar.json');
/**
 * 発掘の台帳。**ブラウザからは読まない。**
 *
 * 盤面と分けているのは転送量のため。台帳は語が増える一方（大半は「道具では
 * なかった」の記録）で、画面に出るのは 10 件だけなので、同じファイルに入れると
 * 閲覧者が毎回数百件ぶんを落とすことになる。
 */
const RADAR_LEDGER_PATH = resolve(DATA_DIR, 'radar-ledger.json');

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

/**
 * 直近の検索インデックスをまとめて読む。
 *
 * 発掘の候補の母集団になる。keywords は要約段で「固有名詞優先」で抽出させた
 * ものなので、道具の名前の供給源としてはこれが一番きれいで、しかも
 * **追加の収集がまったく要らない**（毎日ダイジェストを作った副産物として溜まる）。
 */
export async function loadRecentIndexEntries(days = 90): Promise<IndexEntry[]> {
  await ensureDirs();
  let files: string[] = [];
  try {
    files = (await readdir(INDEX_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }

  // 月別シャードなので、日数 / 30 + 1 ファイル読めば必要な期間をカバーできる
  const limit = Math.max(2, Math.ceil(days / 30) + 1);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const out: IndexEntry[] = [];
  for (const file of files.slice(0, limit)) {
    const entries = await readJsonOr<IndexEntry[]>(resolve(INDEX_DIR, file), []);
    for (const e of entries) if (e.date >= cutoff) out.push(e);
  }
  return out;
}

/** 発掘の台帳を読む。無ければ空（初回は候補の同定から始まる） */
export async function loadRadarLedger(): Promise<RadarLedgerEntry[]> {
  await ensureDirs();
  const raw = await readJsonOr<RadarLedgerEntry[]>(RADAR_LEDGER_PATH, []);
  return Array.isArray(raw) ? raw.filter((e) => e && typeof e.name === 'string') : [];
}

/**
 * 前回の盤面に載っていた id。
 *
 * 道具は腐らないので、コミュニティのイベントと違って期限では落とさない。
 * 毎日同じ盤面を眺めることになるので、差分（NEW）が見えるかどうかが
 * この画面の読みやすさを決める。
 */
export async function loadPreviousRadarIds(): Promise<Set<string>> {
  await ensureDirs();
  const board = await readJsonOr<Partial<RadarBoard>>(RADAR_PATH, {});
  return new Set((board.items ?? []).map((i) => i.id));
}

export async function saveRadarBoard(
  board: RadarBoard,
  ledger: readonly RadarLedgerEntry[],
): Promise<void> {
  await ensureDirs();
  await writeJson(RADAR_PATH, board);
  // 台帳は名前順で書く。日々の差分が並び替えではなく中身の変化だけになるようにする
  await writeJson(
    RADAR_LEDGER_PATH,
    [...ledger].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const counts = Object.entries(board.byVerdict)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  log.info(`保存: data/radar.json (${board.items.length} 件 — ${counts})`);
  log.info(`保存: data/radar-ledger.json (${ledger.length} 語)`);
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
