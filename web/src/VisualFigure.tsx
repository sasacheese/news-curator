import { Fragment } from 'react';
import type { Visual } from './types';

/**
 * 記事の要点の図。
 *
 * 4 形式とも、無理にチャートにしないことを優先している。
 * - comparison: 対比するのはテキストなので、グラフではなく 2 カラムの表。
 *   before を無彩色・after をアクセント色にする「emphasis」で、どちらが今かを色で示す。
 * - flow: 順序が本質なのでステップ図。
 * - metrics: 2 本だけの棒グラフはアンチパターンなので stat tile（値＋デルタ）。
 *   増減の色（good/critical）は色覚特性によっては区別できないため、
 *   必ず矢印グリフと数値を併記し、色だけに意味を持たせない。
 * - architecture: 何がどこを経由してどこへ届くか。層を縦に積む。
 */
export function VisualFigure({ visual }: { visual: Visual }) {
  return (
    <figure className="figure">
      <figcaption className="figure__caption">{visual.title}</figcaption>
      {visual.type === 'comparison' && <Comparison visual={visual} />}
      {visual.type === 'flow' && <Flow visual={visual} />}
      {visual.type === 'metrics' && <Metrics visual={visual} />}
      {visual.type === 'architecture' && <Architecture visual={visual} />}
    </figure>
  );
}

/**
 * 構成図。層を上から下へ積み、層の間に「何が渡るか」を置く。
 *
 * **任意の位置にノードを置いて矢印で結ぶ図にはしていない。** それをやるには座標か
 * レイアウト計算が必要で、線が交差した瞬間に読めなくなる。記事に出てくる構成の
 * ほとんどは「呼ぶ側 → 経由するもの → 実体」の層で表せるので、層に限って
 * 描画が必ず一意に決まるようにした。狭い画面でも、層の中で要素が折り返すだけで崩れない。
 *
 * highlight（記事が論じている当のもの）は色だけに頼らず、記号と読み上げ文を併記する。
 */
function Architecture({ visual }: { visual: Extract<Visual, { type: 'architecture' }> }) {
  const last = visual.layers.length - 1;
  /*
   * 全層でいちばん多いノード数に列を揃える。
   *
   * 幅が中身なりだと、経路が 2 本ある構成（人が通る道とエージェントが通る道）で
   * 「左の列どうしが繋がっている」ことが読めない——実データでちょうどそうなった。
   * 列を固定すると並び順が縦の対応として読めるので、生成側にも n 番目には上の層の
   * n 番目から繋がるものを置かせている。
   */
  const columns = Math.max(...visual.layers.map((l) => l.nodes.length));
  return (
    <div className="arch">
      {visual.layers.map((layer, i) => (
        <Fragment key={i}>
          <div className="arch__layer">
            <span className="arch__layer-label">{layer.label}</span>
            <div
              className="arch__nodes"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {layer.nodes.map((node, j) => (
                <div
                  className={node.highlight ? 'arch__node arch__node--focus' : 'arch__node'}
                  key={j}
                >
                  <span className="arch__node-name">
                    {/* 色だけに頼らない。記号に読み上げ名を持たせる（BuzzChip と同じ方針） */}
                    {node.highlight && (
                      <span
                        className="arch__node-mark"
                        role="img"
                        aria-label="この記事が論じているもの"
                        title="この記事が論じているもの"
                      >
                        ◆
                      </span>
                    )}
                    {node.name}
                  </span>
                  {node.note && <span className="arch__node-note">{node.note}</span>}
                </div>
              ))}
            </div>
          </div>
          {/* 層の間に置くので、最後の層の via は出さない（下に繋ぐ先が無い） */}
          {i < last && (
            <p className="arch__via">
              <span aria-hidden="true">↓</span>
              {layer.via && <span className="arch__via-label">{layer.via}</span>}
            </p>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function Comparison({ visual }: { visual: Extract<Visual, { type: 'comparison' }> }) {
  return (
    <div className="cmp" role="table" aria-label={visual.title}>
      <div className="cmp__head" role="row">
        <span role="columnheader" />
        <span className="cmp__label" role="columnheader">
          {visual.beforeLabel}
        </span>
        <span className="cmp__label cmp__label--after" role="columnheader">
          {visual.afterLabel}
        </span>
      </div>
      {visual.rows.map((row, i) => (
        <div className="cmp__row" role="row" key={i}>
          <span className="cmp__aspect" role="rowheader">
            {row.aspect}
          </span>
          {/* data-label は狭い画面で縦積みにしたときの見出しになる（styles.css 参照） */}
          <span className="cmp__cell cmp__cell--before" role="cell" data-label={visual.beforeLabel}>
            {row.before}
          </span>
          <span className="cmp__cell cmp__cell--after" role="cell" data-label={visual.afterLabel}>
            {row.after}
          </span>
        </div>
      ))}
    </div>
  );
}

function Flow({ visual }: { visual: Extract<Visual, { type: 'flow' }> }) {
  return (
    <ol className="flow" aria-label={visual.title}>
      {visual.steps.map((step, i) => (
        <li className="flow__step" key={i}>
          <span className="flow__num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="flow__label">{step.label}</span>
          {step.detail && <span className="flow__detail">{step.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

const DIRECTION_GLYPH: Record<string, string> = {
  'up-good': '↑',
  'down-good': '↓',
  neutral: '→',
};

function Metrics({ visual }: { visual: Extract<Visual, { type: 'metrics' }> }) {
  return (
    <div className="metrics" aria-label={visual.title}>
      {visual.items.map((item, i) => {
        const improved = item.direction !== 'neutral' && item.baseline !== null;
        return (
          <div className="metric" key={i}>
            <span className="metric__label">{item.label}</span>
            <span className="metric__value">{item.value}</span>
            {item.baseline !== null && (
              <span
                className={improved ? 'metric__delta metric__delta--good' : 'metric__delta'}
              >
                {/* 色だけに頼らないよう、矢印と「〜から」の文言を必ず添える */}
                <span aria-hidden="true">{DIRECTION_GLYPH[item.direction] ?? '→'}</span>{' '}
                {item.baseline} から
              </span>
            )}
            {item.note && <span className="metric__note">{item.note}</span>}
          </div>
        );
      })}
    </div>
  );
}
