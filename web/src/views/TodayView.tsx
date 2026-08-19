import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { AuthorModal } from '../AuthorModal';
import { OtherArticles } from '../OtherArticles';
import { ReleaseList } from '../ReleaseList';
import { VisualFigure } from '../VisualFigure';
import { TrendBand } from '../TrendBand';
import { WatchlistPanel } from '../WatchlistPanel';
import { loadDigest } from '../api';
import { Annotated } from '../Annotated';
import { AskClaudeButton } from '../AskClaudeButton';
import { askContextForTop } from '../askClaude';
import { BuzzChip } from '../components';
import {
  Chip,
  CopyButton,
  Empty,
  Figures,
  Notice,
  ShareButtons,
  Takeaways,
  Thumbnail,
} from '../components';
import { DebateScaffold } from '../DebateScaffold';
import { FeedbackButtons } from '../FeedbackButtons';
import { groupByLane } from '../lanes';
import type {
  Clash,
  Debate,
  DeepDive,
  Digest,
  Manifest,
  Prerequisite,
  RankedItem,
  TopItem,
} from '../types';
import { formatDateLabel, formatPublished, metricSummary, safeUrl, takeawayLines } from '../format';

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

  const topGroups = groupByLane(shown.top, 'top');

  const digestShown = shown;

  return (
    <>
      {dateBar}

      {digestShown.notes.map((note, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Notice>{note}</Notice>
        </div>
      ))}

      {((digestShown.summary && digestShown.summary.length > 0) || digestShown.outlook) && (
        <section className="today-summary" aria-label="今日のサマリー">
          <p className="today-summary__title">今日のサマリー</p>
          {digestShown.summary && digestShown.summary.length > 0 && (
            <ul className="today-summary__list">
              {digestShown.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {/* 上の行は今日の事実、こちらは数日の流れからの推測。混ぜずに区切って出す */}
          {digestShown.outlook && (
            <p className="today-summary__outlook">
              <span className="today-summary__outlook-label">この先の見立て</span>
              {digestShown.outlook}
            </p>
          )}
        </section>
      )}

      {/*
        動いている話題の帯。ここは気づきの入口で、追うのはトレンドタブ側。
        過去日を開いているときは出さない（盤面は日付を持たないので嘘になる）。
      */}
      <TrendBand isToday={targetDate != null && targetDate === manifest?.latest} />

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
              {g.label} {g.items.length}
            </h2>
            {g.lead && <p className="section-lead">{g.lead}</p>}
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

  for (const g of groupByLane(digest.top, 'top')) {
    entries.push({ id: g.id, label: `${g.label} ${g.items.length}` });
    for (const item of g.items) {
      entries.push({ id: cardDomId(item.id), label: item.title, nested: true });
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
  const takeaways = takeawayLines(item);
  /*
   * 画像がある日だけ右に列を足す。無い日は今までどおりの 1 列で、余白も空かない。
   * 配信元から画像が消えていたときも同じ 1 列に戻すため、失敗をここで持つ
   * （画像だけ消すと、列の幅が空白の帯として残る）。
   */
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = thumbFailed ? undefined : safeUrl(item.imageUrl);
  return (
    /*
     * 畳んだ状態を既定にする。カード 1 枚が長く、6 枚並ぶとスクロール量が多いため。
     * 見出し・読みどころ・所要時間まで畳んだまま見えるので、開く前に選べる。
     * summary の中にリンクやボタンを置くと開閉と競合するので、
     * 元記事リンクと著者は本文側に移してある。
     */
    <details className="card" id={cardDomId(item.id)}>
      <summary className={thumb ? 'card__head card__head--thumb' : 'card__head'}>
        <div className="card__meta">
          <span className="rank">{item.rank}</span>
          <Chip accent>{item.category}</Chip>
          <Chip>{item.sourceLabel}</Chip>
          <Chip title="AI による関心一致スコア">スコア {item.score}</Chip>
          {item.buzz && <BuzzChip />}
          <Chip>約 {d.readingMinutes} 分</Chip>
          {metricSummary(item.metrics) && <Chip>{metricSummary(item.metrics)}</Chip>}
        </div>
        {/*
          * 見出しは元記事のタイトルそのもの。以前はサイト側で付けた headline を
          * 大きく出し、その下に元題を小さく添えていたが、headline は oneLiner・
          * 3行要約・summary に続く 4 つ目の要約で、読まれていなかった。
          */}
        <h3 className="card__headline">{item.title}</h3>
        <Takeaways lines={takeaways} />
        {thumb && <Thumbnail src={thumb} onFailed={() => setThumbFailed(true)} />}
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

        {/*
          * 記事の中の画像は要約の直後に置く。解説の中の引用なので、前提知識や図より前
          * ——「記事が何を見せているか」は、こちらが作った図（visual）より先に来る。
          */}
        {d.figures && d.figures.length > 0 && <Figures figures={d.figures} />}

        {/*
          * 新しい形（clashes を持つ日）では、争点は下の「争点」項目がまとめて担う
          * ——1 行の争点も論点ごとの対も同じ見出しの下に置く。ここに二列ブロックを
          * 出すと、同じ対立を 2 回読ませることになる。
          * 旧形式の日は、従来どおりここで二列ブロックを出す。
          */}
        {item.debate && !(d.lane === 'talk' && d.clashes?.length) && (
          <DebateScaffold debate={item.debate} />
        )}

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

        <CardBody deep={d} itemId={item.id} prerequisites={pr} debate={item.debate} />

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
        {/* 読んだ直後に詰まったところを聞く動線なので、元記事リンクの隣に置く */}
        <AskClaudeButton context={askContextForTop(item)} />
        <ShareButtons url={item.url} tweetText={item.oneLiner} />
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
            lane: item.lane,
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

/**
 * カードの本体。レーンごとに項目構成が違う。
 *
 * 「何が変わるか」と「何ができるようになるか」は以前は別項目だったが、同じ差分を
 * 二度書いていた。3 レーンとも見ているのは同じ差分で、見る向きが違うだけなので、
 * レーンごとに 1 項目へ統合してある（知る = 影響範囲 / 作る = できるようになること /
 * 話す = そもそも差分ではないので持たない）。
 */
function CardBody({
  deep,
  itemId,
  prerequisites,
  debate,
}: {
  deep: DeepDive;
  itemId: string;
  prerequisites: Prerequisite[];
  /** 話す レーンのとき、「争点」項目の頭に置く 1 行として使う */
  debate?: Debate | null;
}) {
  const list = (label: string, items: string[], key: string, caveat = false) =>
    items.length > 0 ? (
      <Detail label={label} caveat={caveat}>
        <ul>
          {items.map((t, i) => (
            <li key={i}>
              <Annotated text={t} prerequisites={prerequisites} idPrefix={`${itemId}-${key}-${i}`} />
            </li>
          ))}
        </ul>
      </Detail>
    ) : null;

  const steps = (label: string, items: string[]) =>
    items.length > 0 ? (
      <Detail label={label}>
        <ol>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
        <CodeBlock code={deep.code} />
      </Detail>
    ) : null;

  /** いまは talk（なぜ今この争点か）と、レーン導入前の日だけが使う */
  const why = (label: string) =>
    deep.whyItMatters ? (
      <Detail label={label}>
        <p>
          <Annotated
            text={deep.whyItMatters}
            prerequisites={prerequisites}
            idPrefix={`${itemId}-why`}
          />
        </p>
      </Detail>
    ) : null;

  switch (deep.lane) {
    case 'know':
      return (
        <>
          {/* 「〜な人」を淡々と並べる。該当するかを目で拾うためだけの一覧 */}
          {list('関係がある人', deep.impact, 'impact')}
          {list('いつから', deep.timeline, 'when')}
          {/* 「確認する」だけで終わらせず、何をするかまで書かせている */}
          {steps('必要なアクション', deep.checkNow)}
          {/* 進行中の事象で、推測を確定として読ませないための枠 */}
          {list('まだ確定していないこと', deep.unknowns, 'unknown', true)}
        </>
      );
    case 'build':
      return (
        <>
          {list('できるようになること', deep.unlocks, 'unlock')}
          {/*
            * 「自分に関係があるか」を先に決められるよう、試し方より上に置く。
            * 中身は人物像ではなく、読者が YES / NO で即答できる条件。
            */}
          {list('使える場面', deep.fitFor, 'fit')}
          {list('向かない場面', deep.notFor, 'notfit')}
          {steps('試し方', deep.howToTry)}
          {list('注意点', deep.caveats, 'caveat', true)}
        </>
      );
    case 'talk':
      /*
       * clashes フィールドの有無で新旧を分ける（長さでは分けない）。
       *
       * 空配列は「新しい形で、かつモデルが争点を組み立てられなかった」を意味する。
       * 実測で、本文が実質ジョークの記事（1,714 字あるので長さでは弾けない）に対して
       * モデルが正しく生成を拒み、clashes も firsthand も 0 件で返ってきた日があった。
       * これを長さで旧形式へ落とすと、旧項目も無いのでカード本体が丸ごと空になる。
       * もっともらしい空の箇条書きを並べるより、組み立てられなかったことを見せる。
       */
      if (deep.clashes) {
        if (deep.clashes.length === 0 && !deep.firsthand?.length) {
          return (
            <p className="card__empty">
              この記事からは争点を組み立てられませんでした。元記事とコメントを直接ご覧ください。
            </p>
          );
        }
        return (
          <>
            <Detail label="争点">
              {/* 争点の 1 行 → 論点ごとの対。見出しを 2 つに割らず 1 つにまとめる */}
              {debate?.axis && <p className="clashes__axis">{debate.axis}</p>}
              <ClashList clashes={deep.clashes} />
            </Detail>
            {/*
              * 中心の問い「この争点に、自分の経験から何を足せるか」に直接答える項目。
              * 切り口だけでは足りない——発信の障壁は「これを自分が言っていいのか」なので、
              * なぜ言えるのかを対で見せる。
              */}
            {(deep.firsthand?.length ?? 0) > 0 && (
              <Detail label="一次情報を出すとしたら？">
                <ul className="firsthand">
                  {deep.firsthand!.map((f, i) => (
                    <li key={i}>
                      <span className="firsthand__angle">{f.angle}</span>
                      <span className="firsthand__why">{f.why}</span>
                    </li>
                  ))}
                </ul>
                <p className="angles__note">切り口だけです。どう書くかはご自身の言葉でどうぞ。</p>
              </Detail>
            )}
            {steps('確かめられること', deep.verify)}
          </>
        );
      }
      return (
        <>
          {list('賛成側の根拠', deep.evidence ?? [], 'ev')}
          {list('反対側の根拠', deep.counterEvidence ?? [], 'cev')}
          {list('成り立つ条件・崩れる条件', deep.whenItHolds ?? [], 'when')}
          {/* 名詞句だけを並べる。文にすると意見の代筆になり、読者の言葉でなくなる */}
          {(deep.angles?.length ?? 0) > 0 && (
            <Detail label="語れる角度">
              <ul className="angles">
                {deep.angles!.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
              <p className="angles__note">
                切り口だけです。どう書くかはご自身の言葉でどうぞ。
              </p>
            </Detail>
          )}
          {steps('自分で確かめる', deep.verify)}
          {why('なぜ今この争点か')}
        </>
      );
    default:
      // レーン導入前に生成した日
      return (
        <>
          {list('何ができるようになるか', deep.whatYouCanDo, 'can')}
          {list('何が変わるか', deep.whatChanges, 'chg')}
          {steps('試し方・使い方', deep.howToTry)}
          {why('なぜ重要か')}
          {list('注意点', deep.caveats, 'caveat', true)}
        </>
      );
  }
}

/**
 * 論点ごとの噛み合い。
 *
 * 以前は「賛成側の根拠」「反対側の根拠」を別々の箇条書きで並べていた。平行な 2 つの
 * リストは噛み合いを表現できず、読者が頭の中で対応づける必要があった（実測では
 * 対応していない項目も混ざっていた）。論点を見出しにして左右に対で置く。
 *
 * 左右に並べるのは DebateScaffold と同じ理由——縦に積むと上が結論に見える。
 */
function ClashList({ clashes }: { clashes: Clash[] }) {
  return (
    <div className="clashes">
      {clashes.map((c, i) => (
        <div className="clash" key={i}>
          <p className="clash__point">{c.point}</p>
          <div className="clash__sides">
            <div className="clash__side">
              <p className="clash__side-label">こう言われる</p>
              <p className="clash__side-body">{c.claim}</p>
            </div>
            <div className="clash__side clash__side--counter">
              <p className="clash__side-label">
                こう返せる
                {/*
                  記事に無い反論をそのまま引用すると「記事にはこう書いてある」と
                  誤って紹介することになる。出所が違うことは形として見せる。
                */}
                {c.counterInArticle === false && <span className="debate__tag">記事の外</span>}
              </p>
              <p className="clash__side-body">{c.counter}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ code }: { code: DeepDive['code'] }) {
  if (!code) return null;
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span className="codeblock__lang">{code.lang}</span>
        <span className="codeblock__caption">{code.caption}</span>
        <span className="codeblock__copy">
          <CopyButton text={code.content} />
        </span>
      </div>
      <pre>
        <code>{code.content}</code>
      </pre>
    </div>
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
