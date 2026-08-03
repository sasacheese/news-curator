import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { AuthorModal } from '../AuthorModal';
import { OtherArticles } from '../OtherArticles';
import { ReleaseList } from '../ReleaseList';
import { VisualFigure } from '../VisualFigure';
import { WatchlistPanel } from '../WatchlistPanel';
import { loadDigest } from '../api';
import { Annotated } from '../Annotated';
import { BuzzChip } from '../components';
import { Chip, CopyButton, Empty, Notice } from '../components';
import { FeedbackButtons } from '../FeedbackButtons';
import type { Digest, Manifest, RankedItem, TopItem } from '../types';
import { formatDateLabel, formatPublished, metricSummary, safeUrl } from '../format';
import { setWalkMinutes } from '../walkerClock';

/**
 * 読み込み中の骨組み。
 *
 * 汎用のカード列ではなく、この画面に出るもの（hero・目次・ベストN カード）と
 * 同じ形にしてある。形が違うと、実際の中身に差し替わった瞬間に高さが飛んで
 * かえって目立つ。
 */
function TodaySkeleton() {
  return (
    <div className="skel" aria-hidden="true">
      <div className="skel__hero">
        <div className="skeleton" style={{ height: 15, width: '62%' }} />
        <div className="skeleton" style={{ height: 12, width: '44%' }} />
      </div>
      <div className="skel__toc">
        {['52%', '68%', '64%', '46%'].map((w, i) => (
          <div key={i} className="skeleton" style={{ height: 12, width: w }} />
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="skel__card">
          <div className="skeleton" style={{ height: 13, width: '38%' }} />
          <div className="skeleton" style={{ height: 21, width: '74%' }} />
          <div className="skeleton" style={{ height: 12, width: '90%' }} />
          <div className="skeleton" style={{ height: 12, width: '66%' }} />
        </div>
      ))}
    </div>
  );
}

interface Props {
  manifest: Manifest | null;
  date?: string;
}

export function TodayView({ manifest, date }: Props) {
  const targetDate = date ?? manifest?.latest ?? null;
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * スケルトンは読み込みが長引いたときだけ出す。
   *
   * 過去日のダイジェストは force-cache で即返るので、読み込み中かどうかで
   * 素直に出し分けると一瞬だけ差し替わってチラつく。少し待ってから出す。
   */
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    if (!targetDate) {
      if (manifest) setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 過去日のダイジェストは書かれた後は変わらないので、キャッシュをそのまま使わせる
    loadDigest(targetDate, manifest?.latest ?? null).then(
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

  useEffect(() => {
    if (!loading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), 160);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // 読了目安を猫に渡す。猫はこの時間でちょうど画面を往復する
  useEffect(() => {
    if (digest) setWalkMinutes(digest.stats.estimatedReadMinutes);
  }, [digest]);

  if (!manifest) return <TodaySkeleton />;

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

  /*
   * 前後の日付は targetDate から出す（digest ではなく）。
   * 読み込み中も日付バーを出しっぱなしにして、ボタンが消えて戻るチラつきを防ぐ。
   */
  const idx = manifest.dates.indexOf(targetDate);
  const newer = idx > 0 ? manifest.dates[idx - 1] : undefined;
  const older = idx >= 0 && idx < manifest.dates.length - 1 ? manifest.dates[idx + 1] : undefined;
  const shown = !loading && digest?.date === targetDate ? digest : null;

  const dateBar = (
    <div className="datebar">
      <h1 className="datebar__date">{formatDateLabel(targetDate)}</h1>
      <div className="datebar__nav">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!older || loading}
          onClick={() => older && navigate(`/today/${older}`)}
        >
          ← 前日
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!newer || loading}
          onClick={() => newer && navigate(`/today/${newer}`)}
        >
          翌日 →
        </button>
      </div>
      <div className="datebar__meta">
        {/* 読み込み中は幅だけ確保して、右側の文字が出入りして揺れないようにする */}
        <span className={shown ? undefined : 'datebar__meta-hold'}>
          {shown ? (
            <>
              対象: {new Date(shown.window.start).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
              {' 〜 '}
              {new Date(shown.window.end).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
            </>
          ) : (
            '読み込み中…'
          )}
        </span>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {dateBar}
        {showSkeleton && <TodaySkeleton />}
      </>
    );
  }

  if (error || !shown) {
    return (
      <>
        {dateBar}
        <Notice kind="error">
          {targetDate} のダイジェストを読み込めませんでした{error ? `: ${error}` : ''}
        </Notice>
      </>
    );
  }

  const topGroups = TOP_GROUPS.map((g) => ({
    ...g,
    items: shown.top.filter((t) => (t.domain === 'ai') === (g.id === 'top-ai')),
  })).filter((g) => g.items.length > 0);

  const digestShown = shown;

  return (
    <>
      {dateBar}

      {digestShown.notes.map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      {/*
        同じ数字を文章と数値タイルで二度出していたので、タイルをやめて 1 つの塊にした。
        上段が「結果」、下段が「その結果に至った経緯」。件数はどちらか一方にしか出ない。
      */}
      <section className="hero">
        <p className="hero__lead">
          あなたの関心に近い <strong>{digestShown.top.length}</strong> 本を深掘りしました。
          読了目安 <strong>約 {digestShown.stats.estimatedReadMinutes} 分</strong>。
        </p>
        <p className="hero__pipeline">
          <span>{digestShown.stats.collected.toLocaleString()} 件を収集</span>
          <span aria-hidden="true">→</span>
          <span>{digestShown.stats.afterDedupe.toLocaleString()} 件に重複整理</span>
          <span aria-hidden="true">→</span>
          <span>{digestShown.stats.ranked.toLocaleString()} 件を AI 採点</span>
        </p>
      </section>

      <Toc digest={digestShown} />

      {digestShown.top.length === 0 ? (
        <Empty title="この日は該当する記事がありませんでした" />
      ) : (
        topGroups.map((g) => (
          <section key={g.id}>
            <h2 className="section-title" id={g.id}>
              {g.label}
              {g.items.length}
            </h2>
            {g.items.map((item) => (
              <TopCard key={item.id} item={item} digestDate={digestShown.date} />
            ))}
          </section>
        ))
      )}

      {/* releases が undefined なのはこの機能より前に生成した日。0 件の日とは区別する */}
      {digestShown.releases && (
        <>
          <h2 className="section-title" id="releases">
            リリース情報 ({digestShown.releases.length})
          </h2>
          {digestShown.releases.length === 0 ? (
            <p className="section-lead">
              この日は監視対象からのリリースがありませんでした。見落としが気になる場合は、
              下の監視対象に追加してください。
            </p>
          ) : (
            <>
              <p className="section-lead">
                順位はつけず全件載せています。知っているかどうかだけで差が出るものなので、
                上から流し読みして気になったものだけ開いてください。
              </p>
              <ReleaseList
                releases={digestShown.releases}
                highlightIds={new Set(digestShown.top.map((t) => t.id))}
                digestDate={digestShown.date}
              />
            </>
          )}
          <WatchlistPanel repo={manifest?.repo} />
        </>
      )}

      {digestShown.others.length > 0 && (
        <>
          <h2 className="section-title" id="others">
            その他の注目記事 ({digestShown.others.length})
          </h2>
          <OtherArticles items={digestShown.others} digestDate={digestShown.date} />
        </>
      )}

      <p className="faint" style={{ fontSize: 12, marginTop: 26 }}>
        採点 {digestShown.models.rank} / 要約 {digestShown.models.summary} ・ 生成{' '}
        {new Date(digestShown.generatedAt).toLocaleString('ja-JP')}
        {digestShown.usage && (
          <>
            {' ・ '}
            <span title={Object.entries(digestShown.usage.stages)
              .map(
                ([stage, s]) =>
                  `${stage}: ${s.requests}req / in ${s.inputTokens.toLocaleString()} / out ${s.outputTokens.toLocaleString()} = $${s.estimatedCostUsd.toFixed(4)}`,
              )
              .join('\n')}>
              API 費用 ${digestShown.usage.totalCostUsd.toFixed(3)}
            </span>
          </>
        )}
      </p>
    </>
  );
}

/** ベストN のグループ。目次と見出しで同じ定義を使う */
const TOP_GROUPS = [
  { id: 'top-ai', label: 'AI のベスト' },
  { id: 'top-general', label: 'AI以外のベスト' },
] as const;

export function cardDomId(id: string): string {
  return `card-${id}`;
}

/**
 * 目的の位置へ移動する。
 *
 * href="#id" は使えない。このアプリはハッシュルーティングなので、
 * ハッシュを書き換えるとルート自体が変わってしまう（日付が飛ぶ）。
 * 記事へ飛ぶときは畳んであるカードを開く——目次から記事名を選ぶのは
 * 「そこへ行きたい」ではなく「それを読みたい」なので。
 */
function jumpTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: 'smooth' });
}

/** ページ内リンクの目次。第2階層にベストNの見出しを出す */
function Toc({ digest }: { digest: Digest }) {
  const entries: { id: string; label: string; count?: number; nested?: boolean }[] = [];

  for (const g of TOP_GROUPS) {
    const items = digest.top.filter((t) => (t.domain === 'ai') === (g.id === 'top-ai'));
    if (items.length === 0) continue;
    entries.push({ id: g.id, label: `${g.label}${items.length}` });
    for (const item of items) {
      entries.push({ id: cardDomId(item.id), label: item.deep.headline, nested: true });
    }
  }
  if (digest.releases?.length) {
    entries.push({ id: 'releases', label: 'リリース情報', count: digest.releases.length });
  }
  if (digest.others.length > 0) {
    entries.push({ id: 'others', label: 'その他の注目記事', count: digest.others.length });
  }

  if (entries.length < 2) return null;

  return (
    <nav className="toc" aria-label="このページの目次">
      {entries.map((e) => (
        <button
          key={e.id}
          type="button"
          className={e.nested ? 'toc__item toc__item--nested' : 'toc__item'}
          onClick={() => jumpTo(e.id)}
        >
          <span className="toc__label">{e.label}</span>
          {e.count != null && <span className="toc__count">{e.count}</span>}
        </button>
      ))}
    </nav>
  );
}

function TopCard({ item, digestDate }: { item: TopItem; digestDate: string }) {
  const d = item.deep;
  const pr = d.prerequisites ?? [];
  return (
    /*
     * 畳んだ状態を既定にする。カード 1 枚が長く、6 枚並ぶとスクロール量が多いため。
     * 見出し・読みどころ・所要時間まで畳んだまま見えるので、開く前に選べる。
     * summary の中にリンクやボタンを置くと開閉と競合するので、
     * 元記事リンクと著者は本文側に移してある。
     */
    <details className="card" id={cardDomId(item.id)}>
      <summary className="card__head">
        <div className="card__meta">
          <span className="rank">{item.rank}</span>
          <Chip accent>{item.category}</Chip>
          <Chip>{item.sourceLabel}</Chip>
          <Chip title="AI による関心一致スコア">スコア {item.score}</Chip>
          {item.buzz && <BuzzChip />}
          <Chip>約 {d.readingMinutes} 分</Chip>
          {metricSummary(item.metrics) && <Chip>{metricSummary(item.metrics)}</Chip>}
        </div>
        <h3 className="card__headline">{d.headline}</h3>
        <p className="card__source-title">{item.title}</p>
        {item.reason && (
          <p className="card__lens">
            <span className="card__lens-label">読みどころ</span>
            {item.reason}
          </p>
        )}
        <span className="card__toggle" aria-hidden="true" />
      </summary>

      <div className="card__body">
        <div className="card__origin">
          <a
            className="card__title-link"
            href={safeUrl(item.url)}
            target="_blank"
            rel="noreferrer noopener"
          >
            ↗ {item.title}
          </a>
          <Byline item={item} />
        </div>
        <p className="card__summary">
          <Annotated text={d.summary} prerequisites={pr} idPrefix={`${item.id}-sum`} />
        </p>

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
                  <dd>
                    {p.stumblingPoint && (
                      <p className="prereq__stumble">{p.stumblingPoint}</p>
                    )}
                    {p.explanation}
                  </dd>
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
                <li key={i}>
                  <Annotated text={t} prerequisites={pr} idPrefix={`${item.id}-can-${i}`} />
                </li>
              ))}
            </ul>
          </Detail>
        )}

        {d.whatChanges.length > 0 && (
          <Detail label="何が変わるか">
            <ul>
              {d.whatChanges.map((t, i) => (
                <li key={i}>
                  <Annotated text={t} prerequisites={pr} idPrefix={`${item.id}-chg-${i}`} />
                </li>
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
            <p>
              <Annotated text={d.whyItMatters} prerequisites={pr} idPrefix={`${item.id}-why`} />
            </p>
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
        <FeedbackButtons
          target={{
            id: item.id,
            tier: 'top',
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
    </details>
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
