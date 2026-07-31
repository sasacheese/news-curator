import type { Visual } from './types';

/**
 * 記事の要点の図。
 *
 * 3 形式とも、無理にチャートにしないことを優先している。
 * - comparison: 対比するのはテキストなので、グラフではなく 2 カラムの表。
 *   before を無彩色・after をアクセント色にする「emphasis」で、どちらが今かを色で示す。
 * - flow: 順序が本質なのでステップ図。
 * - metrics: 2 本だけの棒グラフはアンチパターンなので stat tile（値＋デルタ）。
 *   増減の色（good/critical）は色覚特性によっては区別できないため、
 *   必ず矢印グリフと数値を併記し、色だけに意味を持たせない。
 */
export function VisualFigure({ visual }: { visual: Visual }) {
  return (
    <figure className="figure">
      <figcaption className="figure__caption">{visual.title}</figcaption>
      {visual.type === 'comparison' && <Comparison visual={visual} />}
      {visual.type === 'flow' && <Flow visual={visual} />}
      {visual.type === 'metrics' && <Metrics visual={visual} />}
    </figure>
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
