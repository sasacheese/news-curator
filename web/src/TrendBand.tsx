import { useEffect, useState } from 'react';
import { loadTrendBoard } from './api';
import { readWatchedTopics } from './settings';
import type { TrendBoard } from './types';

/** 帯に出すチップの上限。ここは気づきの入口なので、一覧性より短さを優先する */
const MAX_CHIPS = 4;

/**
 * 「今日」タブに置く、動いている話題の帯。
 *
 * トレンドを専用タブだけに置くと、毎朝「今日」しか見ない人の目に永久に入らない。
 * ここは気づきの入口で、追うのはトレンドタブ側。
 *
 * **今日ぶんを見ているときだけ**出す。盤面は日付を持たないので、過去日の
 * アーカイブに今の盤面を出すと嘘になる。
 */
export function TrendBand({ isToday }: { isToday: boolean }) {
  const [board, setBoard] = useState<TrendBoard | null>(null);

  useEffect(() => {
    if (!isToday) return;
    let cancelled = false;
    loadTrendBoard().then(
      (b) => !cancelled && setBoard(b),
      () => undefined, // 未生成のリポジトリでは 404。帯を出さないだけ
    );
    return () => {
      cancelled = true;
    };
  }, [isToday]);

  if (!isToday || !board) return null;

  const watched = readWatchedTopics();
  /*
   * 追っている話題を先に出す。★を付けた話題の新着がここに出ることが、
   * ★を付ける動機になる。
   */
  const chips = [...board.hot, ...board.keep]
    .sort((a, b) => Number(watched.includes(b.key)) - Number(watched.includes(a.key)))
    .slice(0, MAX_CHIPS);
  if (chips.length === 0) return null;

  return (
    /*
     * ラベル・チップ・リンクの 3 つ。広い画面では 1 行、狭い画面では
     * 「ラベルとリンクの行」＋「チップの列」の 2 行になる（CSS 側で組み替える）。
     */
    <section className="tband" aria-label="動いている話題">
      <span className="tband__label">動いている話題</span>
      <div className="tband__chips">
        {chips.map((topic) => (
          <a
            key={topic.key}
            className={`tchip${topic.lift == null && topic.state === 'hot' ? ' tchip--new' : ''}${
              watched.includes(topic.key) ? ' tchip--watched' : ''
            }`}
            href="#/trend"
          >
            {topic.name}
            <span className="tchip__n">
              {topic.lift == null && topic.state === 'hot' ? 'NEW' : `+${topic.today}`}
            </span>
          </a>
        ))}
      </div>
      <a className="tband__all" href="#/trend">
        トレンド →
      </a>
    </section>
  );
}
