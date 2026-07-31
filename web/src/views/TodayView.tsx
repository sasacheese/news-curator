import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { AuthorModal } from '../AuthorModal';
import { VisualFigure } from '../VisualFigure';
import { loadDigest } from '../api';
import { Chip, CopyButton, Empty, LoadingCards, Notice } from '../components';
import type { Digest, Manifest, RankedItem, TopItem } from '../types';
import { formatDateLabel, formatPublished, metricSummary, safeUrl } from '../format';

interface Props {
  manifest: Manifest | null;
  date?: string;
}

export function TodayView({ manifest, date }: Props) {
  const targetDate = date ?? manifest?.latest ?? null;
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!targetDate) {
      if (manifest) setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDigest(targetDate).then(
      (d) => {
        if (!cancelled) {
          setDigest(d);
          setLoading(false);
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [targetDate, manifest]);

  if (!manifest || loading) return <LoadingCards />;

  if (!targetDate || manifest.dates.length === 0) {
    return (
      <Empty title="まだダイジェストがありません">
        <p>
          GitHub Actions の <code>Daily digest</code> ワークフローを一度手動実行すると、ここに
          最初のダイジェストが表示されます。
        </p>
      </Empty>
    );
  }

  if (error || !digest) {
    return (
      <Notice kind="error">
        {targetDate} のダイジェストを読み込めませんでした{error ? `: ${error}` : ''}
      </Notice>
    );
  }

  const idx = manifest.dates.indexOf(digest.date);
  const newer = idx > 0 ? manifest.dates[idx - 1] : undefined;
  const older = idx >= 0 && idx < manifest.dates.length - 1 ? manifest.dates[idx + 1] : undefined;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">{formatDateLabel(digest.date)}</h1>
        <div className="datebar__nav">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!older}
            onClick={() => older && navigate(`/today/${older}`)}
          >
            ← 前日
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!newer}
            onClick={() => newer && navigate(`/today/${newer}`)}
          >
            翌日 →
          </button>
        </div>
        <div className="datebar__meta">
          <span>
            対象: {new Date(digest.window.start).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
            {' 〜 '}
            {new Date(digest.window.end).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
          </span>
        </div>
      </div>

      {digest.notes.map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      <section className="hero">
        <p className="hero__lead">
          収集した <strong>{digest.stats.collected.toLocaleString()}</strong> 件から、
          あなたの関心に近い <strong>{digest.top.length}</strong> 本を深掘りしました。
          読了目安 <strong>約 {digest.stats.estimatedReadMinutes} 分</strong>。
        </p>
        <div className="hero__stats">
          <div className="stat">
            <span className="stat__value">{digest.stats.collected.toLocaleString()}</span>
            <span className="stat__label">収集</span>
          </div>
          <div className="stat">
            <span className="stat__value">{digest.stats.afterDedupe.toLocaleString()}</span>
            <span className="stat__label">重複除去後</span>
          </div>
          <div className="stat">
            <span className="stat__value">{digest.stats.ranked.toLocaleString()}</span>
            <span className="stat__label">AI採点</span>
          </div>
          <div className="stat">
            <span className="stat__value">{digest.stats.estimatedReadMinutes}</span>
            <span className="stat__label">読了目安 (分)</span>
          </div>
        </div>
      </section>

      <h2 className="section-title">今日のベスト{digest.top.length}</h2>
      {digest.top.length === 0 ? (
        <Empty title="この日は該当する記事がありませんでした" />
      ) : (
        digest.top.map((item) => <TopCard key={item.id} item={item} />)
      )}

      {digest.others.length > 0 && (
        <>
          <h2 className="section-title">その他の注目記事 ({digest.others.length})</h2>
          <div className="list">
            {digest.others.map((item) => (
              <OtherRow key={item.id} item={item} />
            ))}
          </div>
        </>
      )}

      <p className="faint" style={{ fontSize: 12, marginTop: 26 }}>
        採点 {digest.models.rank} / 要約 {digest.models.summary} ・ 生成{' '}
        {new Date(digest.generatedAt).toLocaleString('ja-JP')}
      </p>
    </>
  );
}

function TopCard({ item }: { item: TopItem }) {
  const d = item.deep;
  return (
    <article className="card">
      <div className="card__head">
        <div className="card__meta">
          <span className="rank">{item.rank}</span>
          <Chip accent>{item.category}</Chip>
          <Chip>{item.sourceLabel}</Chip>
          <Chip title="AI による関心一致スコア">スコア {item.score}</Chip>
          <Chip>約 {d.readingMinutes} 分</Chip>
          {metricSummary(item.metrics) && <Chip>{metricSummary(item.metrics)}</Chip>}
        </div>
        <h3 className="card__headline">{d.headline}</h3>
        <a className="card__title-link" href={safeUrl(item.url)} target="_blank" rel="noreferrer noopener">
          ↗ {item.title}
        </a>
        <Byline item={item} />
      </div>

      <div className="card__body">
        <p className="card__summary">{d.summary}</p>

        {(d.prerequisites?.length ?? 0) > 0 && (
          <details className="prereq">
            <summary className="prereq__summary">
              <span className="prereq__marker" aria-hidden="true" />
              前提知識
              <span className="prereq__count">{d.prerequisites!.length}</span>
            </summary>
            <dl className="prereq__list">
              {d.prerequisites!.map((p, i) => (
                <div className="prereq__item" key={i}>
                  <dt>{p.term}</dt>
                  <dd>{p.explanation}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        {d.visual && <VisualFigure visual={d.visual} />}

        {d.whatYouCanDo.length > 0 && (
          <Detail label="何ができるようになるか">
            <ul>
              {d.whatYouCanDo.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </Detail>
        )}

        {d.whatChanges.length > 0 && (
          <Detail label="何が変わるか">
            <ul>
              {d.whatChanges.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </Detail>
        )}

        {d.howToTry.length > 0 && (
          <Detail label="試し方・使い方">
            <ol>
              {d.howToTry.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            {d.code && (
              <div className="codeblock">
                <div className="codeblock__bar">
                  <span className="codeblock__lang">{d.code.lang}</span>
                  <span className="codeblock__caption">{d.code.caption}</span>
                  <span className="codeblock__copy">
                    <CopyButton text={d.code.content} />
                  </span>
                </div>
                <pre>
                  <code>{d.code.content}</code>
                </pre>
              </div>
            )}
          </Detail>
        )}

        {d.whyItMatters && (
          <Detail label="なぜ重要か">
            <p>{d.whyItMatters}</p>
          </Detail>
        )}

        {d.caveats.length > 0 && (
          <Detail label="注意点" caveat>
            <ul>
              {d.caveats.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </Detail>
        )}

        {d.relatedLinks.length > 0 && (
          <Detail label="関連リンク">
            <ul>
              {d.relatedLinks.map((l, i) => (
                <li key={i}>
                  <a href={safeUrl(l.url)} target="_blank" rel="noreferrer noopener">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </Detail>
        )}
      </div>

      <div className="card__foot">
        <div className="chips">
          {item.keywords.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              onClick={() => navigate(`/search?q=${encodeURIComponent(k)}`)}
              title={`「${k}」で検索`}
            >
              #{k}
            </button>
          ))}
        </div>
        <a className="btn btn--sm" href={safeUrl(item.url)} target="_blank" rel="noreferrer noopener">
          元記事を読む ↗
        </a>
      </div>
    </article>
  );
}

/** 公開日時と著者。著者情報が取れているソースではクリックで詳細を出す。 */
function Byline({ item }: { item: RankedItem }) {
  const [open, setOpen] = useState(false);
  const published = formatPublished(item.publishedAt);
  const detail = item.authorDetail;

  if (!published && !item.author) return null;

  return (
    <p className="byline">
      {published && (
        <time dateTime={item.publishedAt} className="byline__time">
          {published}
        </time>
      )}
      {item.author && (
        <>
          <span className="byline__sep" aria-hidden="true">
            ·
          </span>
          {detail ? (
            <>
              <button type="button" className="byline__author" onClick={() => setOpen(true)}>
                {item.author}
              </button>
              {open && (
                <AuthorModal
                  author={detail}
                  sourceLabel={item.sourceLabel}
                  onClose={() => setOpen(false)}
                />
              )}
            </>
          ) : (
            <span className="byline__author byline__author--plain">{item.author}</span>
          )}
        </>
      )}
    </p>
  );
}

function Detail({
  label,
  children,
  caveat = false,
}: {
  label: string;
  children: React.ReactNode;
  caveat?: boolean;
}) {
  return (
    <div className={caveat ? 'detail detail--caveat' : 'detail'}>
      <div className="detail__label">{label}</div>
      {children}
    </div>
  );
}

function OtherRow({ item }: { item: RankedItem }) {
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
        <Byline item={item} />
        <div className="row__meta">
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
