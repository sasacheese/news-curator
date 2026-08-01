import { useMemo, useState } from 'react';
import { navigate } from './App';
import { Chip } from './components';
import { metricSummary, safeUrl } from './format';
import type { Durability, Payoff, RankedItem } from './types';

/**
 * その他の注目記事。
 *
 * AI とそれ以外を別セクションにしている。母集団が AI に大きく偏っていて
 * （実測で上位 15 件のうち 13〜15 件が AI）、混ぜて並べると AI 以外が
 * 1〜2 件しか目に入らないため。収集側でも別々の枠を与えている。
 *
 * 並べ替えは「重要度」と「時間対効果」の 2 通り。時間対効果は payoff を
 * readingMinutes で割った値で、短時間で手を動かせるものが上に来る。
 */

const PAYOFF_LABELS: Record<Payoff, string> = {
  apply: '手を動かせる',
  decide: '判断材料',
  aware: '知っておく',
};

/** 時間対効果の重み。並べ替えの根拠を明示できるよう、単純な定義にしている。 */
const PAYOFF_WEIGHT: Record<Payoff, number> = { apply: 3, decide: 2, aware: 1 };

const DURABILITY_LABELS: Record<Durability, string> = {
  foundational: '長く効く',
  durable: '1年もつ',
  ephemeral: '旬の話題',
};

function efficiency(item: RankedItem): number {
  const weight = PAYOFF_WEIGHT[item.payoff ?? 'aware'];
  return weight / Math.max(1, item.readingMinutes ?? 5);
}

type SortKey = 'score' | 'efficiency';

function Row({ item }: { item: RankedItem }) {
  return (
    <div className="row">
      <div className="row__score">{item.score}</div>
      <div className="row__main">
        <p className="row__title">
          <a href={safeUrl(item.url)} target="_blank" rel="noreferrer noopener">
            {item.title}
          </a>
        </p>
        <p className="row__summary">{item.oneLiner}</p>
        {item.reason && (
          <p className="row__lens">
            <span className="row__lens-label">読みどころ</span>
            {item.reason}
          </p>
        )}
        <div className="row__meta">
          {item.readingMinutes != null && item.payoff && (
            <Chip accent={item.payoff === 'apply'}>
              {item.readingMinutes}分 · {PAYOFF_LABELS[item.payoff]}
            </Chip>
          )}
          {item.durability === 'foundational' && (
            <Chip title="言語仕様・Web標準など、数年単位で効く情報">
              {DURABILITY_LABELS.foundational}
            </Chip>
          )}
          <Chip>{item.category}</Chip>
          <span>{item.sourceLabel}</span>
          {metricSummary(item.metrics) && <span>· {metricSummary(item.metrics)}</span>}
          {item.keywords.slice(0, 4).map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              onClick={() => navigate(`/search?q=${encodeURIComponent(k)}`)}
            >
              #{k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OtherArticles({ items }: { items: RankedItem[] }) {
  const [sort, setSort] = useState<SortKey>('score');

  const groups = useMemo(() => {
    const order = (list: RankedItem[]) =>
      sort === 'score' ? list : [...list].sort((a, b) => efficiency(b) - efficiency(a));
    return [
      { key: 'ai', label: 'AI', items: order(items.filter((i) => i.domain === 'ai')) },
      { key: 'general', label: 'AI以外', items: order(items.filter((i) => i.domain !== 'ai')) },
    ].filter((g) => g.items.length > 0);
  }, [items, sort]);

  if (groups.length === 0) return null;

  return (
    <>
      <div className="listctl">
        <div className="segmented">
          <button type="button" aria-pressed={sort === 'score'} onClick={() => setSort('score')}>
            重要度順
          </button>
          <button
            type="button"
            aria-pressed={sort === 'efficiency'}
            onClick={() => setSort('efficiency')}
            title="読了目安が短く、手を動かせるものほど上に来ます"
          >
            時間対効果順
          </button>
        </div>
      </div>

      {groups.map((group) => (
        <section className="othergroup" key={group.key}>
          <h3 className="othergroup__title">
            {group.label}
            <span className="othergroup__count">{group.items.length}</span>
          </h3>
          <div className="list">
            {group.items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
