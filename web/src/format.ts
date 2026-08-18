import type { Metrics } from './types';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export function formatDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return `${y}年${m}月${d}日(${wd})`;
}

export function formatDateShort(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** YYYY-MM → 2026年8月 */
export function formatMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  if (!y || !m) return month;
  return `${Number(y)}年${Number(m)}月`;
}

/** manifest.dates（新しい順）を月ごとの日数に畳む。読み込まずに月の目次を出すため */
export function daysPerMonth(dates: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const date of dates) {
    const month = date.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return counts;
}

/** 記事の公開日時（JST）。同日なら時刻まで、それ以外は日付まで。 */
export function formatPublished(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 人気指標を1行にまとめる */
export function metricSummary(m: Metrics): string {
  const parts: string[] = [];
  if (m.likes) parts.push(`♥ ${m.likes}`);
  if (m.stocks) parts.push(`📑 ${m.stocks}`);
  if (m.hatena) parts.push(`B! ${m.hatena}`);
  if (m.points) parts.push(`HN ${m.points}`);
  if (m.stars) parts.push(`★ ${m.stars.toLocaleString()}`);
  return parts.join(' · ');
}

/**
 * 外部由来の URL を href に入れる前に検証する。
 *
 * 記事の URL や関連リンクは外部 API・RSS・LLM の出力から来るので信用できない。
 * `javascript:` などのスキームを弾かないと、設定画面で localStorage に保存した
 * GitHub トークンをクリック 1 回で抜かれる経路になる。
 * 弾いた場合は undefined を返し、React 側では href の無いテキストとして描画される。
 */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export const SOURCE_LABELS: Record<string, string> = {
  qiita: 'Qiita',
  zenn: 'Zenn',
  hatena: 'はてブ',
  hackernews: 'Hacker News',
  devto: 'dev.to',
  github_release: 'GitHub Release',
  github_repo: 'GitHub リポジトリ',
  changelog: 'CHANGELOG',
  rss: '公式ブログ / RSS',
};

/**
 * 「3行で要約」の行を取り出す。
 *
 * takeaways 導入より前の日は reason（1 本の文）しか持っていないので、
 * それを 1 行として扱う。過去日を開いたときに何も出ないのを避けるため。
 */
export function takeawayLines(item: { takeaways?: string[]; reason?: string }): string[] {
  const lines = (item.takeaways ?? []).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return lines;
  const legacy = item.reason?.trim();
  return legacy ? [legacy] : [];
}
