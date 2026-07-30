import { useCallback, useEffect, useState } from 'react';
import { loadManifest } from './api';
import { Notice } from './components';
import type { Manifest } from './types';
import { ArchiveView } from './views/ArchiveView';
import { SearchView } from './views/SearchView';
import { SettingsView } from './views/SettingsView';
import { TodayView } from './views/TodayView';

export type Route =
  | { name: 'today'; date?: string }
  | { name: 'search'; q?: string }
  | { name: 'archive' }
  | { name: 'settings' };

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const segments = (path ?? '').split('/').filter(Boolean);

  switch (segments[0]) {
    case 'search':
      return { name: 'search', q: params.get('q') ?? undefined };
    case 'archive':
      return { name: 'archive' };
    case 'settings':
      return { name: 'settings' };
    case 'today':
      return { name: 'today', date: segments[1] };
    default:
      return { name: 'today' };
  }
}

export function navigate(to: string): void {
  location.hash = to.startsWith('#') ? to : `#${to}`;
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

const TABS: { key: Route['name']; label: string; href: string }[] = [
  { key: 'today', label: '今日', href: '/today' },
  { key: 'archive', label: 'アーカイブ', href: '/archive' },
  { key: 'search', label: '検索', href: '/search' },
  { key: 'settings', label: '設定', href: '/settings' },
];

export function App() {
  const route = useRoute();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadManifest().then(setManifest, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  // `/` で検索へ、`t` で今日へ
  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      navigate('/search');
    } else if (e.key === 't') {
      navigate('/today');
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className="app">
      <header className="site-header">
        <div className="container site-header__inner">
          <a className="brand" href="#/today">
            <span className="brand__mark">☕</span>
            <span>
              Tech Digest
              <span className="brand__sub"> ／ 毎朝7:00・30分</span>
            </span>
          </a>
          <nav className="tabs" aria-label="メインナビゲーション">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-current={route.name === tab.key}
                onClick={() => navigate(tab.href)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main>
        <div className="container">
          {error && (
            <Notice kind="error">
              データを読み込めませんでした: {error}
              <br />
              まだ一度もダイジェストが生成されていない可能性があります。GitHub Actions の
              <code> Daily digest </code> ワークフローを手動実行してください。
            </Notice>
          )}

          {!error && route.name === 'today' && (
            <TodayView manifest={manifest} date={route.date} />
          )}
          {!error && route.name === 'archive' && <ArchiveView manifest={manifest} />}
          {!error && route.name === 'search' && (
            <SearchView manifest={manifest} initialQuery={route.q ?? ''} />
          )}
          {route.name === 'settings' && <SettingsView />}
        </div>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>
            毎朝 7:00 JST に、前日 7:00 からの 24 時間ぶんを収集・要約しています。
            {manifest?.updatedAt && (
              <> 最終更新 {new Date(manifest.updatedAt).toLocaleString('ja-JP')}。</>
            )}
          </p>
          <p>キーボード: / で検索、t で今日のダイジェスト。</p>
        </div>
      </footer>
    </div>
  );
}
