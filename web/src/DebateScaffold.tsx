import type { Debate } from './types';

/**
 * 「論点」レーン（talk）の記事に添える足場。
 *
 * 意見が出ない理由を分解すると、主張の理解 → 反対側の把握 → 自分の位置決め →
 * 自分にしか書けない一点、の順にハードルが上がる。詰まるのは最後で、
 * 「同意」「違うと思う」なら誰でも書けるが、それは投稿する価値が無い。
 *
 * だからここでは**意見の下書きを出さない**。下書きを渡すと読者自身の言葉で
 * なくなるうえ、裏を取っていない文章がそのまま外に出てしまう。渡すのは、
 * 争点の形と、読者の経験が証拠に変わる一点だけ。
 *
 * 賛成側と反対側を左右に並べているのは、どちらを選んでもよいことを形で示すため。
 * 縦に積むと上が結論に見える。
 */
export function DebateScaffold({ debate, compact }: { debate: Debate; compact?: boolean }) {
  return (
    <section className={compact ? 'debate debate--compact' : 'debate'}>
      <p className="debate__axis">
        <span className="debate__axis-label">争点</span>
        {debate.axis}
      </p>

      <div className="debate__sides">
        <div className="debate__side">
          <p className="debate__side-label">記事の立場</p>
          <p className="debate__side-body">{debate.forSide}</p>
        </div>
        <div className="debate__side debate__side--against">
          <p className="debate__side-label">
            反対の立場
            {/*
              記事に無い反論をそのまま引用すると「記事にはこう書いてある」と
              誤って紹介することになる。出所が違うことは形として見せる。
            */}
            {debate.oneSided && <span className="debate__tag">記事の外</span>}
          </p>
          <p className="debate__side-body">{debate.againstSide}</p>
        </div>
      </div>

      {debate.yourAngle && (
        <p className="debate__angle">
          <span className="debate__angle-label">あなたが持っている材料</span>
          {debate.yourAngle}
        </p>
      )}
    </section>
  );
}
