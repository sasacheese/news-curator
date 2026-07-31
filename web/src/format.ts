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
