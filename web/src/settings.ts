import type { TopicsConfig } from './types';

const TOPICS_KEY = 'news-curator:topics';
const TOKEN_KEY = 'news-curator:github-token';
const THEME_KEY = 'news-curator:theme';
const REPO_KEY = 'news-curator:repo';

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

/* ---------- GitHub への書き戻し ---------- */

export function getRepo(): string {
  return localStorage.getItem(REPO_KEY) ?? inferRepoFromLocation();
}

export function setRepo(repo: string): void {
  localStorage.setItem(REPO_KEY, repo.trim());
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

/** github.io の URL から owner/repo を推測する */
function inferRepoFromLocation(): string {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return '';
  const owner = host.replace('.github.io', '');
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return repo ? `${owner}/${repo}` : '';
}

interface ContentsResponse {
  sha: string;
}

/**
 * config/topics.json を GitHub Contents API で直接コミットする。
 * トークンはブラウザの localStorage にのみ保存され、送信先は api.github.com だけ。
 */
export async function pushTopicsToGitHub(
  config: TopicsConfig,
  opts: { repo: string; token: string; branch?: string },
): Promise<string> {
  const { repo, token, branch = 'main' } = opts;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('リポジトリは owner/repo 形式で入力してください');
  }

  const path = 'config/topics.json';
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  const current = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
  if (current.status === 401 || current.status === 403) {
    throw new Error('認証に失敗しました。トークンの権限（Contents: Read and write）を確認してください');
  }
  if (!current.ok && current.status !== 404) {
    throw new Error(`既存ファイルの取得に失敗しました (HTTP ${current.status})`);
  }
  const sha = current.ok ? ((await current.json()) as ContentsResponse).sha : undefined;

  const body = JSON.stringify(
    {
      message: 'chore(config): update topics from web UI',
      content: toBase64(`${JSON.stringify(config, null, 2)}\n`),
      branch,
      ...(sha ? { sha } : {}),
    },
    null,
    0,
  );

  const res = await fetch(api, { method: 'PUT', headers, body });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`コミットに失敗しました (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { commit?: { html_url?: string } };
  return json.commit?.html_url ?? `https://github.com/${repo}/blob/${branch}/${path}`;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
