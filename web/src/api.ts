import type {
  CommunityBoard,
  Digest,
  IndexEntry,
  Manifest,
  TopicsConfig,
  Watchlist,
} from './types';

const BASE = import.meta.env.BASE_URL;

/**
 * 過去ぶんのキャッシュを捨てたいときに上げる。
 *
 * 過去月のインデックスと過去日のダイジェストは「一度書かれたら変わらない」前提で
 * force-cache しているので、履歴を作り直したときはここを上げないと古いものが
 * 残り続ける。日々の更新で上げる必要はない（最新ぶんは毎回検証している）。
 */
const ARCHIVE_CACHE_VERSION = 1;

/*
 * GitHub Pages は cache-control を max-age=600 に固定していて変更できない
 * （_headers も使えない）。一方でこちら側が全 fetch に no-cache を付けていたため、
 * 10 分以内であっても毎回サーバーに問い合わせていた。
 *
 * 中身が変わるもの（manifest・当月のインデックス・当日のダイジェスト）だけ検証し、
 * 確定済みの過去ぶんはキャッシュをそのまま使う。
 */
type Freshness = 'live' | 'archived';

async function getJson<T>(path: string, freshness: Freshness = 'live'): Promise<T> {
  const url =
    freshness === 'archived' ? `${BASE}${path}?v=${ARCHIVE_CACHE_VERSION}` : `${BASE}${path}`;
  const res = await fetch(url, {
    // force-cache は「あればそれを使い、検証もしない」。不変なものにだけ使う。
    cache: freshness === 'archived' ? 'force-cache' : 'no-cache',
  });
  if (!res.ok) throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export function loadManifest(): Promise<Manifest> {
  return getJson<Manifest>('data/manifest.json');
}

export function loadDigest(date: string, latestDate?: string | null): Promise<Digest> {
  // 最新日ぶんは走り直しで差し替わることがあるので検証する
  const freshness: Freshness = latestDate && date < latestDate ? 'archived' : 'live';
  return getJson<Digest>(`data/digests/${date}.json`, freshness);
}

/**
 * コミュニティの盤面を読む。
 *
 * 日付を持たない 1 ファイルで、毎回まるごと差し替わる。過去ぶんが無いので
 * 常に検証する（`archived` にできるものが無い）。
 * まだ一度も生成していないリポジトリでは 404 になるので、呼び出し側で受ける。
 */
export function loadCommunityBoard(): Promise<CommunityBoard> {
  return getJson<CommunityBoard>('data/community.json');
}

/**
 * 1 ヶ月ぶんのインデックスを読む。
 *
 * 読み込みの単位はこれ 1 つだけにしてある。アーカイブが何年ぶんに増えても、
 * 1 回の転送量は 1 ヶ月ぶん（実測 14.6KB/日 × 日数、gzip で約 1/3.5）で一定。
 */
export function loadIndexShard(month: string, latestMonth?: string | null): Promise<IndexEntry[]> {
  const freshness: Freshness = latestMonth && month < latestMonth ? 'archived' : 'live';
  return getJson<IndexEntry[]>(`data/index/${month}.json`, freshness);
}

export function loadTopicsConfig(): Promise<TopicsConfig> {
  return getJson<TopicsConfig>('config/topics.json');
}

export function loadWatchlist(): Promise<Watchlist> {
  return getJson<Watchlist>('config/watchlist.json');
}

/**
 * 全期間を月ごとに順に読む。
 *
 * 1 リクエストは 1 ヶ月ぶんのまま、読めた月から順に onShard へ渡す。
 * 全部を待たないので、古い月が増えても最初の結果はすぐ出る。
 * 取れなかった月は空として飛ばす（1 ヶ月の欠けで検索全体を止めない）。
 */
export async function loadIndexByMonth(
  months: readonly string[],
  latestMonth: string | null,
  onShard: (month: string, entries: IndexEntry[]) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  for (const month of months) {
    if (isCancelled?.()) return;
    let entries: IndexEntry[] = [];
    try {
      entries = await loadIndexShard(month, latestMonth);
    } catch {
      entries = [];
    }
    if (isCancelled?.()) return;
    onShard(month, entries);
  }
}
