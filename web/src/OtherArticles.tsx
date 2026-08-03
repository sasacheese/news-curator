import { useMemo, useState } from 'react';
import { navigate } from './App';
import { BuzzChip, Chip } from './components';
import { FeedbackButtons } from './FeedbackButtons';
import { metricSummary, safeUrl } from './format';
import type { Payoff, RankedItem } from './types';

/**
 * その他の注目記事。
 *
 * AI とそれ以外をタブで切り替える。母集団が AI に大きく偏っていて
 * （実測で 12 件中 8 件が AI）、混ぜて並べると AI 以外が埋もれるため。
 * 収集側でも AI 以外に全体の 1/3 を確保している。
 *
 * 並びは重要度順の一本にした。時間対効果順も付けていたが使われなかったので外した。
 */

const PAYOFF_LABELS: Record<Payoff, string> = {
  apply: '手を動かせる',
  decide: '判断材料',
  aware: '知っておく',
};

type DomainTab = 'ai' | 'general';

function Row({ item, digestDate }: { item: RankedItem; digestDate: string }) {
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
          {item.buzz && <BuzzChip />}
          {item.readingMinutes != null && item.payoff && (
            <Chip accent={item.payoff === 'apply'}>
              {item.readingMinutes}分 · {PAYOFF_LABELS[item.payoff]}
            </Chip>
          )}
          {item.durability === 'foundational' && (
            <Chip title="言語仕様・Web標準など、数年単位で効く情報">長く効く</Chip>
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
          <FeedbackButtons
            target={{
              id: item.id,
              tier: 'other',
              digestDate,
              source: item.source,
              sourceLabel: item.sourceLabel,
              title: item.title,
              url: item.url,
              category: item.category,
              domain: item.domain,
              matchedTopics: item.matchedTopics,
              score: item.score,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function OtherArticles({ items, digestDate }: { items: RankedItem[]; digestDate: string }) {
  const groups = useMemo(
    () => ({
      ai: items.filter((i) => i.domain === 'ai'),
      general: items.filter((i) => i.domain !== 'ai'),
    }),
    [items],
  );
  // 件数の多い側を初期表示にする（片方が 0 件のときに空を見せないため）
  const [tab, setTab] = useState<DomainTab>(
    groups.ai.length >= groups.general.length ? 'ai' : 'general',
  );

  const shown = groups[tab];

  return (
    <>
      <div className="listctl">
        <div className="segmented">
          {(
            [
              ['ai', 'AI'],
              ['general', 'AI以外'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
              {label} <span className="segmented__count">{groups[key].length}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>
          この日は該当する記事がありませんでした。
        </p>
      ) : (
        <div className="list">
          {shown.map((item) => (
            <Row key={item.id} item={item} digestDate={digestDate} />
          ))}
        </div>
      )}
    </>
  );
}
