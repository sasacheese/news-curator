import { useEffect, useState } from 'react';
import { loadWatchlist } from './api';
import { safeUrl } from './format';
import type { Watchlist } from './types';

/**
 * リリース情報の監視対象。
 *
 * 「今何を見ているか」がわからないと足すべきものも判断できないので、
 * 一覧を畳んだ状態で置き、そこから GitHub の編集画面へ直接飛ばす。
 * 書き込みはリポジトリ側の権限に任せる（ブラウザにトークンを持たせない）。
 */

const WATCHLIST_PATH = 'config/watchlist.json';

function editUrl(repo: string): string {
  return `https://github.com/${repo}/edit/main/${WATCHLIST_PATH}`;
}

export function WatchlistPanel({ repo }: { repo?: string | null }) {
  const [list, setList] = useState<Watchlist | null>(null);

  useEffect(() => {
    let alive = true;
    loadWatchlist().then(
      (w) => alive && setList(w),
      () => alive && setList(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (!list) return null;

  const repos = list.repos ?? [];
  const feeds = list.feeds ?? [];
  const changelogs = list.changelogs ?? [];
  const valid = repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;

  return (
    <details className="watch">
      <summary className="watch__summary">
        監視対象
        <span className="watch__counts">
          リポジトリ {repos.length} ・ フィード {feeds.length} ・ CHANGELOG {changelogs.length}
        </span>
      </summary>

      <div className="watch__body">
        <p className="watch__lead">
          ここに載っているものだけがリリース情報の対象です。追加・削除は{' '}
          <code>{WATCHLIST_PATH}</code> を編集してコミットすれば、翌朝の実行から反映されます。
          {valid && (
            <>
              {' '}
              <a
                className="watch__edit"
                href={editUrl(valid)}
                target="_blank"
                rel="noreferrer noopener"
              >
                GitHubで編集 ↗
              </a>
            </>
          )}
        </p>

        <div className="watch__group">
          <h4>GitHub リリース ({repos.length})</h4>
          <ul className="watch__repos">
            {repos.map((r) => (
              <li key={r}>
                <a href={`https://github.com/${r}/releases`} target="_blank" rel="noreferrer noopener">
                  {r}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="watch__group">
          <h4>フィード ({feeds.length})</h4>
          <ul className="watch__repos">
            {feeds.map((f) => (
              <li key={f.url}>
                <a href={safeUrl(f.url)} target="_blank" rel="noreferrer noopener">
                  {f.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        {changelogs.length > 0 && (
          <div className="watch__group">
            <h4>CHANGELOG ({changelogs.length})</h4>
            <ul className="watch__repos">
              {changelogs.map((c) => (
                <li key={c.url}>
                  <a
                    href={safeUrl(c.homepage ?? c.url)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {c.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
