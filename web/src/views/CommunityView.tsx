import { useEffect, useState } from 'react';
import { CommunityBoard } from '../CommunityBoard';
import { loadCommunityBoard } from '../api';
import { Empty, LoadingCards, Notice } from '../components';
import type { CommunityBoard as Board } from '../types';

/**
 * コミュニティ（イベント・登壇募集・もくもく会）。
 *
 * 日次ダイジェストとは別のタブにしている。流動性が高く、日ごとの記録として
 * 残す意味が無いためで、日次に埋めると同じ内容が毎日並び、過去日を開いたときに
 * 終わったイベントが出る。データも `data/community.json` 1 ファイルで、
 * 毎朝まるごと差し替わる。
 */
export function CommunityView() {
  const [board, setBoard] = useState<Board | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadCommunityBoard().then(
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
      <Empty title="まだイベント情報がありません">
        <p>Daily digest ワークフローを実行すると作られます。</p>
      </Empty>
    );
  }
  if (!board) return <LoadingCards count={3} />;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">コミュニティ</h1>
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
        行ける範囲（オンライン + 都内、カンファレンス相当は距離を問わず）で、
        この先の開催予定と登壇募集を出しています。前回から新しく載ったものには NEW が付きます。
      </p>

      {board.items.length === 0 ? (
        <Empty title="いまは該当するイベントがありません" />
      ) : (
        <CommunityBoard items={board.items} boardDate={board.date} />
      )}

      <p className="faint" style={{ fontSize: 12, marginTop: 22 }}>
        同じ主催の定例回は直近の 1 回だけ載せています。
        検索やアーカイブには入れていません（開催が過ぎると価値が無くなるため）。
      </p>
    </>
  );
}
