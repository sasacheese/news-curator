import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { loadManifest } from './api';
import { Notice } from './components';
import { RETIRED_TOKEN_KEY, purgeRetiredKeys } from './settings';
import { Logo } from './Logo';
import { QuickSearch, openQuickSearch } from './QuickSearch';
import { SelectionSearch } from './SelectionSearch';
import type { Manifest } from './types';
import { ArchiveView } from './views/ArchiveView';
import { CommunityView } from './views/CommunityView';
import { RadarView } from './views/RadarView';
import { SearchView } from './views/SearchView';
import { SettingsView } from './views/SettingsView';
import { TodayView } from './views/TodayView';
import { TrendView } from './views/TrendView';

export type Route =
  | { name: 'today'; date?: string }
  | { name: 'search'; q?: string }
  | { name: 'archive' }
  | { name: 'community' }
  | { name: 'trend' }
  | { name: 'radar' }
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
    case 'community':
      return { name: 'community' };
    case 'trend':
      return { name: 'trend' };
    case 'radar':
      return { name: 'radar' };
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

type Tab = { key: Route['name']; label: string; href: string };

/**
 * 設定はナビゲーションに出さない。`#/settings` を直接開いたときだけ使える。
 *
 * このサイトは公開されているので、読み手向けでない画面をリンクで晒さない。
 * 一度開いたら以降タブに出す、という以前の緩和はやめた（URL 直打ちのみ）。
 * 画面自体に秘密は無い（トークン方式をやめたため）ので、これは秘匿ではなく
 * 「読み手に見せる導線を絞る」ための措置。
 */
const TABS: Tab[] = [
  { key: 'today', label: '今日', href: '/today' },
  /*
   * トレンドは「今日」の隣。日次の差分（今日）と、日をまたいだ状態（トレンド）は
   * 対になっているので、この 2 つは並べる。
   */
  { key: 'trend', label: 'トレンド', href: '/trend' },
  /*
   * 発掘はその次。今日・トレンドが「いま何が起きているか」を時間で見る枠なのに対して、
   * こちらは時間ではなく**地域の差**を見る枠なので、日次の 2 つのあとに置く。
   */
  { key: 'radar', label: '発掘', href: '/radar' },
  { key: 'community', label: 'コミュニティ', href: '/community' },
  { key: 'archive', label: 'アーカイブ', href: '/archive' },
  { key: 'search', label: '検索', href: '/search' },
];

const SECRET_TAPS = 5;
const SECRET_TAP_WINDOW_MS = 3000;

/**
 * ロゴマークを素早く 5 回叩いたら発火する。設定画面への隠し入口。
 *
 * ホーム画面に追加した PWA には URL バーが無いので `#/settings` を直接打てず、
 * 画面にリンクを出していない設定画面へ到達する手段が無かった。端末の操作だけで
 * 入れる経路として連打を用意する。ロゴを叩いても `#/today` へは飛ばさない
 * （連打の途中でページが変わらないように）。ブランド名のテキスト側は今まで通り。
 */
function useSecretTap(onTrigger: () => void) {
  const taps = useRef<number[]>([]);

  return useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      taps.current = [...taps.current, now].filter((t) => now - t < SECRET_TAP_WINDOW_MS);
      if (taps.current.length < SECRET_TAPS) return;
      taps.current = [];
      onTrigger();
    },
    [onTrigger],
  );
}

export function App() {
  const route = useRoute();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purged, setPurged] = useState<string[]>([]);
  const onLogoTap = useSecretTap(useCallback(() => navigate('/settings'), []));

  // 撤去した機能が残したトークンを消す。過去に保存したブラウザだけが対象
  useEffect(() => setPurged(purgeRetiredKeys()), []);

  /**
   * 設定画面を開いている間だけ noindex を立てる。
   *
   * ハッシュはサーバーに送られないので `#/settings` がクローラに
   * 別ページとして拾われることはそもそも無い。ナビゲーションからリンクも
   * 外したので導線も無い。それでも、JS を実行するクローラがこの状態を
   * 踏んだときに拾われないよう明示しておく。
   */
  useEffect(() => {
    if (route.name !== 'settings') return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow, noarchive';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [route.name]);

  useEffect(() => {
    loadManifest().then(setManifest, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  /*
   * `/` と Ctrl/Cmd+K でクイック検索、`t` で今日へ。
   *
   * `/` は以前は検索画面へ飛ばしていたが、読んでいる途中に引きたいだけなのに
   * 画面ごと入れ替わって読み位置が消えていた。上に重ねる窓に変える
   * （検索画面へは窓の中から行ける）。Ctrl/Cmd+K は入力中でも効かせる。
   */
  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openQuickSearch();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      openQuickSearch();
    } else if (e.key === 't') {
      navigate('/today');
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  /*
   * 狭い画面ではタブが横スクロールになるので、選ばれているタブが枠の外に
   * 置き去りになることがある（検索は右端）。ルートが変わるたびに引き寄せる。
   */
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    /*
     * 幅が決まるのを 1 フレーム待つ。マウント直後に計算すると帯がまだ
     * 溢れていない扱いで、#/search を直に開いたとき検索タブが枠外に
     * 置き去りになっていた。
     */
    const frame = requestAnimationFrame(() => {
      const nav = tabsRef.current;
      const current = nav?.querySelector<HTMLElement>('[aria-current="true"]');
      if (!nav || !current) return;
      /*
       * scrollIntoView は使わない。縦の位置まで巻き込む余地があるうえ、
       * 滑らかな移動が無効な環境では何も起きないことがある。帯の中央に
       * 来る位置を自分で出して、その値を直接入れる。
       */
      const offset = current.getBoundingClientRect().left - nav.getBoundingClientRect().left;
      const centered = nav.scrollLeft + offset - (nav.clientWidth - current.offsetWidth) / 2;
      nav.scrollLeft = Math.max(0, centered);
    });
    return () => cancelAnimationFrame(frame);
  }, [route.name]);

  return (
    <div className="app">
      <header className="site-header">
        <div className="container site-header__inner">
          <a className="brand" href="#/today">
            <span className="brand__mark" onClick={onLogoTap}>
              <Logo />
            </span>
            <span>
              Tech Digest
              <span className="brand__sub"> ／ 毎朝8:00・30分</span>
            </span>
          </a>
          <nav className="tabs" aria-label="メインナビゲーション" ref={tabsRef}>
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
        {/*
          * 今日の画面だけ、広い画面で目次を左のレールに出す（→ .container--today）。
          * 他の画面は 1 列のまま——並びが縦に長いだけの画面に余白を割いても、
          * 目が横に泳ぐぶん読みにくくなる。
          */}
        <div className={route.name === 'today' ? 'container container--today' : 'container'}>
          {purged.includes(RETIRED_TOKEN_KEY) && (
            <div style={{ marginBottom: 18 }}>
              <Notice kind="info">
                このブラウザに保存されていた GitHub トークンを削除しました。
                設定の反映はトークンを使わない方式（GitHub の Web エディタ）に変わりました。
                削除しても失効はしないので、{' '}
                <a
                  href="https://github.com/settings/personal-access-tokens"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  GitHub の設定
                </a>{' '}
                から revoke してください。
              </Notice>
            </div>
          )}

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
          {/* 盤面は manifest に依存しない（日付を持たない 1 ファイルなので） */}
          {route.name === 'radar' && <RadarView />}
          {route.name === 'community' && <CommunityView />}
          {route.name === 'trend' && <TrendView />}
          {!error && route.name === 'archive' && <ArchiveView manifest={manifest} />}
          {!error && route.name === 'search' && (
            <SearchView manifest={manifest} initialQuery={route.q ?? ''} />
          )}
          {route.name === 'settings' && <SettingsView manifest={manifest} />}
        </div>
      </main>

      <QuickSearch manifest={manifest} />
      <SelectionSearch />

      <footer className="site-footer">
        <div className="container">
          <p>
            {/*
              cron は 7:00 JST に起動するが、GitHub Actions の cron は数分〜十数分
              遅れることがあり、収集と要約にも数分かかる。実際に読めるようになるのは
              8:00 までなので、そう書いている。
            */}
            毎朝 8:00 JST までに、前日 7:00 からの 24 時間分を収集・要約しています。
            {manifest?.updatedAt && (
              <> 最終更新 {new Date(manifest.updatedAt).toLocaleString('ja-JP')}。</>
            )}
          </p>
          <p>キーボード: / または Ctrl/⌘+K で調べる、t で今日のダイジェスト。本文を選ぶとその語をそのまま引けます。</p>
        </div>
      </footer>
    </div>
  );
}
