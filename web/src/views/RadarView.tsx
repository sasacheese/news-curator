import { useEffect, useState } from 'react';
import { RadarBoard } from '../RadarBoard';
import { loadRadarBoard } from '../api';
import { Empty, LoadingCards, Notice } from '../components';
import type { RadarBoard as Board } from '../types';

/**
 * 発掘（まだ日本で使われていない道具）。
 *
 * 日次ダイジェストとは別のタブにしている。軸が違う——ダイジェストは
 * 「今日公開されたか」で引くが、ここで見ているのは「その道具が今どういう
 * 状態にあるか」で、ある 1 日の出来事ではない。データも `data/radar.json`
 * 1 ファイルで、毎朝まるごと差し替わる。
 */
export function RadarView() {
  const [board, setBoard] = useState<Board | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadRadarBoard().then(
      (b) => !cancelled && setBoard(b),
      // まだ一度も生成していないリポジトリでは 404 になる。エラー扱いにしない
      () => !cancelled && setMissing(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (missing) {
    return (
      <Empty title="まだ発掘の結果がありません">
        <p>
          Daily digest ワークフローを実行すると作られます。過去のダイジェストに出てきた
          道具の名前を母集団にするので、数日ぶん溜まってから結果が出ます。
        </p>
      </Empty>
    );
  }
  if (!board) return <LoadingCards count={2} />;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">発掘</h1>
        <p className="datebar__meta">
          {board.items.length} 件 ・ 更新 {new Date(board.updatedAt).toLocaleString('ja-JP')}
        </p>
      </div>

      {(board.notes ?? []).map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      <p className="section-lead" style={{ marginTop: 4 }}>
        海外での使われ方と、日本語で書かれた記事の量を別々に測って、
        差が大きいものだけを出しています。数字はすべて実測で、
        Qiita・Zenn・npm・GitHub から毎回引き直しています。
      </p>

      {board.items.length === 0 ? (
        <Empty title="いまは該当するものがありません">
          <p>
            基準を満たすものが無い日は空になります（枠を埋めるために基準を下げると、
            紹介した相手に「それもう使ってます」と言われるものが混ざります）。
            {board.stats && (
              <>
                {' '}
                台帳には {board.stats.ledgerSize} 語あり、うち {board.stats.notTool} 語は
                道具ではないと判定済みです。
              </>
            )}
          </p>
        </Empty>
      ) : (
        <RadarBoard items={board.items} date={board.date} />
      )}

      <p className="faint" style={{ fontSize: 12, marginTop: 22 }}>
        母集団は過去 90 日のダイジェストに出てきた固有名詞と、当日の GitHub 急上昇
        リポジトリです。1 日に計測する語数には上限があるので、新しく見つけた道具が
        ここに出るまで数日かかることがあります。
        {board.stats && (
          <>
            {' '}
            今回の計測は {board.stats.measuredToday} 語 / 台帳は {board.stats.ledgerSize} 語。
          </>
        )}
      </p>
    </>
  );
}
