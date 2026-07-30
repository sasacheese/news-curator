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
