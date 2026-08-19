import { useCallback, useEffect, useState } from 'react';
import { TrendCard } from '../TrendCard';
import { loadTrendBoard } from '../api';
import { Empty, LoadingCards, Notice } from '../components';
import { readWatchedTopics, toggleWatchedTopic } from '../settings';
import type { TrendBoard, TrendState, TrendTopic } from '../types';

/**
 * トレンド（話題台帳）。
 *
 * 日次ダイジェストとは別のタブにしている。ダイジェストは前日 7:00 からの
 * 24 時間に公開されたものだけを扱う差分刊行なので、3 日続いている話題は
 * 2 日目以降どこにも出ない。トレンドは「いまの状態」で、日付を持たない。
 * 過去日のアーカイブに埋めると、3 か月後にその日を開いた人に当時の盤面が
 * 出てしまう（それは嘘になる）。
 */
export function TrendView() {
  const [board, setBoard] = useState<TrendBoard | null>(null);
  const [missing, setMissing] = useState(false);
  const [watched, setWatched] = useState<string[]>(() => readWatchedTopics());

  useEffect(() => {
    let cancelled = false;
    loadTrendBoard().then(
      (b) => !cancelled && setBoard(b),
      // まだ一度も生成していないリポジトリでは 404 になる。エラー扱いにしない
      () => !cancelled && setMissing(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggleWatch = useCallback((key: string) => {
    setWatched(toggleWatchedTopic(key));
  }, []);

  if (missing) {
    return (
      <Empty title="まだトレンドがありません">
        <p>Daily digest ワークフローを実行すると作られます。</p>
      </Empty>
    );
  }
  if (!board) return <LoadingCards count={3} />;

  const sections: { state: TrendState; title: string; lead: string; items: TrendTopic[] }[] = [
    {
      state: 'hot',
      title: board.warmingUp ? '今日よく出ている話題' : '今日動いた',
      lead: board.warmingUp
        ? '収集した記事に多く出てきた話題です。平常と比べるには履歴が足りないので、いまは本数順に並べています。'
        : '新しく立った話題と、平常より急に本数が増えた話題。ここだけ見れば追いつけます。',
      items: board.hot,
    },
    {
      state: 'keep',
      title: '追跡中',
      lead: '平常より高い水準が続いている話題。ここが「ウォッチ」の本体です。',
      items: board.keep,
    },
    {
      state: 'cool',
      title: '落ち着いた',
      lead: '数日前まで動いていて、いまは平常に戻った話題。終わったことが分かるので、追う対象を減らせます。',
      items: board.cool,
    },
  ];

  const total = board.hot.length + board.keep.length + board.cool.length;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">トレンド</h1>
        <p className="datebar__meta">
          {board.date} 時点 ・ 直近 {board.windowDays} 日 ・ 更新{' '}
          {new Date(board.updatedAt).toLocaleString('ja-JP')}
        </p>
      </div>

      {board.notes.map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      <p className="section-lead" style={{ marginTop: 4 }}>
        話題ごとの現在地です。順位はつけません。掲載した記事には印がついているので、
        自分が見た地点からの差分だけを追えます。
      </p>

      {total === 0 ? (
        <Empty title="動いている話題がありません">
          <p>
            台帳は {board.ledgerDays} 日ぶん貯まっています。数日ぶんが揃うと、
            平常との差で判定できるようになります。
          </p>
        </Empty>
      ) : (
        sections.map(
          (section) =>
            section.items.length > 0 && (
              <section key={section.state}>
                <h2 className="section-title" id={`trend-${section.state}`}>
                  {section.title} ({section.items.length})
                </h2>
                <p className="section-lead">{section.lead}</p>
                <div className="tcards">
                  {section.items.map((topic) => (
                    <TrendCard
                      key={topic.key}
                      topic={topic}
                      warmingUp={board.warmingUp}
                      watched={watched.includes(topic.key)}
                      onToggleWatch={() => onToggleWatch(topic.key)}
                    />
                  ))}
                </div>
              </section>
            ),
        )
      )}

      {board.ubiquitous.length > 0 && (
        <section className="tbg">
          <p className="tbg__label">常に出ている背景</p>
          <p className="tbg__values">{board.ubiquitous.join(' · ')}</p>
          <p className="tbg__note">
            台帳の 7 割以上の日に出ている語です。関心領域そのものなので、動きとしては扱いません。
          </p>
        </section>
      )}
    </>
  );
}
