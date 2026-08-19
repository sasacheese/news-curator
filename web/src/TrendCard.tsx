import { useState } from 'react';
import { LANE_LABELS } from './lanes';
import type { TrendArticle, TrendTopic } from './types';

/** 既定で見せるタイムラインの件数。残りは畳む */
const LEAD = 3;

function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 日別本数のスパークライン。
 *
 * 折れ線は出さない。読者が見て行動が変わるのは「伸びているか枯れているか」の
 * 形だけで、値の精密な読み取りではない。最後の日だけ色を付けて現在地を示す。
 */
function Spark({ values, muted }: { values: number[]; muted: boolean }) {
  const max = Math.max(...values, 1);
  const w = 7;
  const gap = 2.6;
  const h = 26;
  const width = values.length * (w + gap) - gap;
  return (
    <svg
      className="tspark"
      viewBox={`0 0 ${width} ${h}`}
      width={width}
      height={h}
      role="img"
      aria-label={`直近 ${values.length} 日の本数。最大 ${max} 本`}
    >
      {values.map((v, i) => {
        const bh = Math.max(1.5, (v / max) * h);
        const isNow = i === values.length - 1 && v > 0 && !muted;
        return (
          <rect
            key={i}
            className={isNow ? 'tspark__bar tspark__bar--now' : v ? 'tspark__bar' : 'tspark__bar--zero'}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={1.5}
          />
        );
      })}
    </svg>
  );
}

/**
 * 掲載の印。
 *
 * この画面が読み直しではなく「自分が見た地点からの差分確認」になるかどうかは、
 * ここが出るかで決まる。未掲載（収集はしたが載せなかったもの）にも印を付ける
 * ——なぜ見た記憶が無いのかが分かるように。
 */
function Placement({ article }: { article: TrendArticle }) {
  if (article.placement === 'none') return <span className="ttag">未掲載</span>;
  if (article.placement === 'release') return <span className="ttag">リリース</span>;
  const lane = article.lane ? LANE_LABELS[article.lane] : '掲載';
  return article.rank != null ? (
    <span className="ttag ttag--rank">
      {lane} {article.rank}位
    </span>
  ) : (
    <span className="ttag">{lane}</span>
  );
}

function Badge({ topic, warmingUp }: { topic: TrendTopic; warmingUp: boolean }) {
  if (topic.state === 'cool') return <span className="tbadge tbadge--cool">落ち着いた</span>;
  if (warmingUp) return <span className="tbadge tbadge--keep">今日 {topic.today} 本</span>;
  if (topic.lift == null && topic.state === 'hot') {
    return <span className="tbadge tbadge--new">今日から</span>;
  }
  if (topic.state === 'hot') {
    return (
      <span className="tbadge tbadge--rise">
        急上昇 <b>×{topic.lift!.toFixed(1)}</b>
      </span>
    );
  }
  // 平常値が取れない（この期間に初めて出た）話題は倍率を出さず「継続中」だけ
  return topic.liftRecent != null ? (
    <span className="tbadge tbadge--keep">
      継続 <b>×{topic.liftRecent.toFixed(1)}</b>
    </span>
  ) : (
    <span className="tbadge tbadge--keep">継続中</span>
  );
}

export function TrendCard({
  topic,
  warmingUp,
  watched,
  onToggleWatch,
}: {
  topic: TrendTopic;
  warmingUp: boolean;
  watched: boolean;
  onToggleWatch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? topic.articles : topic.articles.slice(0, LEAD);
  const hidden = topic.articles.length - LEAD;

  return (
    <article className={`tcard${topic.state === 'cool' ? ' tcard--cool' : ''}`}>
      <header className="tcard__hd">
        <div className="tcard__id">
          <h3 className="tcard__name">{topic.name}</h3>
          {topic.variants.length > 0 && (
            <p className="tcard__vars">{topic.variants.join(' · ')}</p>
          )}
        </div>
        <div className="tcard__st">
          <Badge topic={topic} warmingUp={warmingUp} />
          <button
            type="button"
            className="twatch"
            aria-pressed={watched}
            onClick={onToggleWatch}
            title={watched ? '追うのをやめる' : 'この話題を追う'}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M8 1.6l1.9 4 4.4.6-3.2 3 .8 4.3L8 11.5 4.1 13.5l.8-4.3-3.2-3 4.4-.6z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span className="visually-hidden">
              {watched ? 'この話題を追うのをやめる' : 'この話題を追う'}
            </span>
          </button>
        </div>
      </header>

      <div className="tcard__meta">
        <span className="tmeta">初出 {shortDate(topic.firstSeen)}</span>
        <span className="tmeta__sep">·</span>
        <span className="tmeta">累計 {topic.total}本</span>
        <span className="tmeta__sep">·</span>
        {topic.today > 0 ? (
          <span className="tmeta tmeta--now">今日 +{topic.today}本</span>
        ) : (
          <span className="tmeta tmeta--off">今日 0本</span>
        )}
        <Spark values={topic.history} muted={topic.state === 'cool'} />
      </div>

      {topic.articles.length === 0 ? (
        <p className="tcard__empty">
          この話題で掲載した記事はまだありません（収集では {topic.today} 本出ています）。
        </p>
      ) : (
        <ol className="tev-list">
          {shown.map((article, i) => (
            <li className="tev" key={`${article.url}-${i}`}>
              <span className="tev__d">{shortDate(article.date)}</span>
              <a
                className="tev__t"
                href={article.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {article.title}
              </a>
              <span className="tev__m">
                {article.date === topic.lastSeen && topic.state !== 'cool' && (
                  <span className="ttag ttag--new">NEW</span>
                )}
                <Placement article={article} />
              </span>
            </li>
          ))}
        </ol>
      )}

      {hidden > 0 && (
        <button
          type="button"
          className="tmore"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'たたむ' : `他 ${hidden} 本を見る`}
        </button>
      )}

      <div className="tcard__ft">
        <a className="tsearch" href={`#/search?q=${encodeURIComponent(topic.name)}`}>
          検索でこの話題の全記事を見る →
        </a>
      </div>
    </article>
  );
}
