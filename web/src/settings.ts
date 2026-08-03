import type { TopicsConfig } from './types';

const TOPICS_KEY = 'news-curator:topics';
const THEME_KEY = 'news-curator:theme';

/**
 * 以前は設定画面から GitHub Contents API を直接叩いており、そのための
 * personal access token とリポジトリ名を localStorage に置いていた。
 * 公開サイトの localStorage に write 権限付きのトークンを常駐させるのは
 * 割に合わないので方式をやめ、GitHub の Web エディタへのリンクに変えた。
 *
 * 過去に保存したトークンが残っているブラウザがあるので、起動時に消す。
 * ただし消しても失効はしないので、README に revoke 手順を書いてある。
 */
export const RETIRED_TOKEN_KEY = 'news-curator:github-token';

const RETIRED_KEYS = [RETIRED_TOKEN_KEY, 'news-curator:repo', 'news-curator:show-settings'];

/**
 * 撤去した機能が残したキーを消す。消したキー名を返す（トークンがあったことを画面に出すため）。
 *
 * 結果は記憶する。StrictMode が effect を 2 回走らせると、2 回目は
 * もう消すものが無くて空配列になり、通知が出ないまま消えてしまう。
 */
let purged: string[] | null = null;

export function purgeRetiredKeys(): string[] {
  if (purged === null) {
    purged = RETIRED_KEYS.filter((k) => localStorage.getItem(k) !== null);
    for (const key of purged) localStorage.removeItem(key);
  }
  return purged;
}

export type Theme = 'auto' | 'light' | 'dark';

/* ---------- テーマ ---------- */

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme = getTheme()): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/* ---------- トピック設定 ---------- */

/** ローカルで編集中の設定（未保存分）。無ければ null。 */
export function getLocalTopics(): TopicsConfig | null {
  const raw = localStorage.getItem(TOPICS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TopicsConfig;
  } catch {
    return null;
  }
}

export function saveLocalTopics(config: TopicsConfig): void {
  localStorage.setItem(TOPICS_KEY, JSON.stringify(config));
}

export function clearLocalTopics(): void {
  localStorage.removeItem(TOPICS_KEY);
}

/* ---------- フィードバック機能の解除 ---------- */

const FEEDBACK_UNLOCK_KEY = 'news-curator:feedback-unlocked';

/**
 * URL の ?fb=<token> が VITE_FEEDBACK_TOKEN と一致したら解除フラグを立てる。
 *
 * 認証ではなく「偶然見つからない」程度の目隠し。トークン自体はビルド済み JS に
 * 平文で入るので、本気で探せば見つかる。実害はスパム投稿程度で、
 * フィードバックデータは Firestore の TTL で数週間後に消える前提。
 */
export function unlockFeedbackFromUrl(): void {
  const token = new URLSearchParams(location.search).get('fb');
  const expected = import.meta.env.VITE_FEEDBACK_TOKEN;
  if (!token || !expected || token !== expected) return;

  localStorage.setItem(FEEDBACK_UNLOCK_KEY, '1');
  const url = new URL(location.href);
  url.searchParams.delete('fb');
  history.replaceState(null, '', url);
}

export function isFeedbackUnlocked(): boolean {
  return localStorage.getItem(FEEDBACK_UNLOCK_KEY) === '1';
}
