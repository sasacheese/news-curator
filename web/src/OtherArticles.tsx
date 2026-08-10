import { useMemo, useState } from 'react';
import { navigate } from './App';
import { BuzzChip, Chip, ShareButtons } from './components';
import { DebateScaffold } from './DebateScaffold';
import { FeedbackButtons } from './FeedbackButtons';
import { metricSummary, safeUrl } from './format';
import { groupByLane } from './lanes';
import type { Payoff, RankedItem } from './types';

/**
 * その他の注目記事。
 *
 * 目的（潮目／手札／論点）をタブで切り替える。
 * 混ぜて 1 列に並べると件数の多い目的が上を占めてしまい、
 * 「今日は何を書けるか」を探しにきた時に見つからない。収集側でも
 * レーンごとに枠を確保している。
 *
 * 並びは重要度順の一本にした。時間対効果順も付けていたが使われなかったので外した。
 */

const PAYOFF_LABELS: Record<Payoff, string> = {
  apply: '手を動かせる',
  decide: '判断材料',
  aware: '知っておく',
};

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
        {/* 一覧でも争点まで見せる。開かないと立場が決められないなら足場にならない */}
        {item.debate && <DebateScaffold debate={item.debate} compact />}
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
          <ShareButtons url={item.url} tweetText={item.oneLiner} />
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
              lane: item.lane,
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
  const groups = useMemo(() => groupByLane(items, 'list'), [items]);
  // 件数の多い側を初期表示にする（先頭が 0 件のときに空を見せないため）
  const [tabId, setTabId] = useState<string | null>(null);
  const active = groups.find((g) => g.id === tabId) ?? groups[0];

  if (!active) {
    return (
      <p className="faint" style={{ fontSize: 13 }}>
        この日は該当する記事がありませんでした。
      </p>
    );
  }

  return (
    <>
      <div className="listctl">
        <div className="segmented">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={g.id === active.id}
              onClick={() => setTabId(g.id)}
            >
              {g.label} <span className="segmented__count">{g.items.length}</span>
            </button>
          ))}
        </div>
      </div>

      {active.lead && <p className="section-lead">{active.lead}</p>}

      <div className="list">
        {active.items.map((item) => (
          <Row key={item.id} item={item} digestDate={digestDate} />
        ))}
      </div>
    </>
  );
}
