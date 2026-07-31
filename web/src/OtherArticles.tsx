import { useMemo, useState } from 'react';
import { navigate } from './App';
import { Chip } from './components';
import { metricSummary, safeUrl } from './format';
import type { Payoff, RankedItem } from './types';

/**
 * その他の注目記事。
 *
 * 「どれを読むのが時間対効果が高いか」を選べるようにするため、各記事に
 * 読了目安（コスト）と payoff（リターン）を出し、その比で並べ替えられるようにした。
 * AI が主題かどうかでの絞り込みも付けている。
 */

const PAYOFF_LABELS: Record<Payoff, string> = {
  apply: '手を動かせる',
  decide: '判断材料',
  aware: '知っておく',
};

/** 時間対効果の重み。並べ替えの根拠を明示できるよう、単純な定義にしている。 */
const PAYOFF_WEIGHT: Record<Payoff, number> = { apply: 3, decide: 2, aware: 1 };

function efficiency(item: RankedItem): number {
  const weight = PAYOFF_WEIGHT[item.payoff ?? 'aware'];
  return weight / Math.max(1, item.readingMinutes ?? 5);
}

type DomainFilter = 'all' | 'ai' | 'general';
type SortKey = 'score' | 'efficiency';

export function OtherArticles({ items }: { items: RankedItem[] }) {
  const [domain, setDomain] = useState<DomainFilter>('all');
  const [sort, setSort] = useState<SortKey>('score');

  const counts = useMemo(
    () => ({
      all: items.length,
      ai: items.filter((i) => i.domain === 'ai').length,
      general: items.filter((i) => i.domain !== 'ai').length,
    }),
    [items],
  );

  const shown = useMemo(() => {
    const filtered = items.filter((i) =>
      domain === 'all' ? true : domain === 'ai' ? i.domain === 'ai' : i.domain !== 'ai',
    );
    if (sort === 'score') return filtered;
    return [...filtered].sort((a, b) => efficiency(b) - efficiency(a));
  }, [items, domain, sort]);

  return (
    <>
      <div className="listctl">
        <div className="segmented">
          {(
            [
              ['all', 'すべて'],
              ['ai', 'AI'],
              ['general', 'AI以外'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={domain === key}
              onClick={() => setDomain(key)}
            >
              {label} <span className="segmented__count">{counts[key]}</span>
            </button>
          ))}
        </div>
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

      {shown.length === 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>
          この条件に合う記事はありません。
        </p>
      ) : (
        <div className="list">
          {shown.map((item) => (
            <div className="row" key={item.id}>
              <div className="row__score">{item.score}</div>
              <div className="row__main">
                <p className="row__title">
                  <a href={safeUrl(item.url)} target="_blank" rel="noreferrer noopener">
                    {item.title}
                  </a>
                </p>
                <p className="row__summary">{item.oneLiner}</p>
                <div className="row__meta">
                  {item.readingMinutes != null && item.payoff && (
                    <Chip accent={item.payoff === 'apply'}>
                      {item.readingMinutes}分 · {PAYOFF_LABELS[item.payoff]}
                    </Chip>
                  )}
                  {item.domain === 'ai' && <Chip>AI</Chip>}
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
          ))}
        </div>
      )}
    </>
  );
}
