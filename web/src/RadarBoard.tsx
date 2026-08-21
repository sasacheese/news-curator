import type { ReactNode } from 'react';
import { TrialSlot } from './TrialSlot';
import { CopyButton } from './components';
import { safeUrl } from './format';
import type { RadarItem, RadarMeasure, RadarVerdict } from './types';

/**
 * 発掘の盤面。
 *
 * この画面の目的は読むことではなく**人に言うこと**なので、レイアウトの主役は
 * 要約ではない。「海外ではこれだけ使われているのに、日本語の記事はこれだけ」
 * という 2 つの数字の対比が主役で、それが紹介の根拠そのものになる。
 *
 * だから対比を左右に並べて、間に矢印ではなく「日本では」と置いている。
 * 数字を縦に積むと 2 つが同列の指標に見えてしまい、差が読み取れない。
 */

const VERDICT_TITLES: Record<RadarVerdict, string> = {
  early: '海外で先行しているもの',
  hidden: '静かに使われているもの',
};

const VERDICT_LEADS: Record<RadarVerdict, string> = {
  early:
    '海外で勢いがあるのに、日本語の記事がまだ少ないもの。' +
    '「海外で話題になってますよ」と言える段階です。',
  hidden:
    'どこでも話題になっていないのに、実際にはかなり使われているもの。' +
    '「知られてないけど便利ですよ」と言える段階です。',
};

const VERDICT_ORDER: RadarVerdict[] = ['early', 'hidden'];

/** 大きい数を日本語で読める形に。ダウンロード数は桁が大きいので万・億に丸める */
function jaCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}億`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString('ja-JP')}万`;
  return n.toLocaleString('ja-JP');
}

function domesticTotal(m: RadarMeasure): number | null {
  if (m.qiitaArticles == null && m.zennArticles == null) return null;
  return (m.qiitaArticles ?? 0) + (m.zennArticles ?? 0);
}

/**
 * 海外と国内の対比。この枠がこの画面の本体。
 *
 * 数え方（フレーズ検索かタグ検索か、総数か下限値か）を title に入れている。
 * 人に話す前にこの数字の意味を確かめられないと、聞かれたときに答えられない。
 */
function Gap({ m }: { m: RadarMeasure }) {
  const domestic = domesticTotal(m);
  const qiitaNote =
    m.qiitaMethod === 'tag'
      ? 'Qiita でこの名前をタグに持つ記事数'
      : 'Qiita でこの名前に言及している記事数';
  const zennNote =
    m.zennComplete === false
      ? 'Zenn の検索結果（1 ページで打ち切られた下限値）'
      : 'Zenn でこの名前をトピックに持つ記事数';

  return (
    <div className="radar__gap">
      <div className="radar__side">
        <p className="radar__side-label">海外での使われ方</p>
        <ul className="radar__figures">
          {m.npmWeekly != null && (
            <li>
              <span className="radar__num">{jaCount(m.npmWeekly)}</span>
              <span className="radar__unit">
                ダウンロード / 週
                {m.npmPackage && (
                  <span className="radar__pkg" title="計測した npm パッケージ">
                    {m.npmPackage}
                    {m.npmVersion ? ` ${m.npmVersion}` : ''}
                  </span>
                )}
              </span>
            </li>
          )}
          {m.githubStars != null && (
            <li>
              <span className="radar__num">{m.githubStars.toLocaleString('ja-JP')}</span>
              <span className="radar__unit">GitHub スター</span>
            </li>
          )}
          {m.npmTrend != null && m.npmTrend >= 1.15 && (
            <li>
              <span className="radar__num">{m.npmTrend.toFixed(2)}倍</span>
              <span className="radar__unit">直近 2 週間のダウンロードの伸び</span>
            </li>
          )}
        </ul>
      </div>

      <p className="radar__vs" aria-hidden="true">
        日本では
      </p>

      <div className="radar__side radar__side--domestic">
        <p className="radar__side-label">日本語で書かれた記事</p>
        {domestic == null ? (
          <p className="radar__num radar__num--unknown">測れず</p>
        ) : (
          <ul className="radar__figures">
            <li>
              <span className="radar__num">
                {domestic.toLocaleString('ja-JP')}
                {m.zennComplete === false ? '+' : ''}
              </span>
              <span className="radar__unit">
                本
                <span className="radar__breakdown">
                  {m.qiitaArticles != null && <span title={qiitaNote}>Qiita {m.qiitaArticles}</span>}
                  {m.zennArticles != null && (
                    <span title={zennNote}>
                      Zenn {m.zennArticles}
                      {m.zennComplete === false ? '+' : ''}
                    </span>
                  )}
                </span>
              </span>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Slack に貼れる形の紹介文。
 *
 * この機能の出口はここ。画面を読んで自分で言い直すのではなく、そのまま貼って
 * 会話を始められるようにする。**数字は計測値をそのまま入れる**（生成された
 * 文章の中の数字ではない）ので、貼った先で突っ込まれても答えられる。
 */
function shareText(item: RadarItem): string {
  const m = item.measure;
  const figures = [
    m.npmWeekly != null ? `npm 週 ${jaCount(m.npmWeekly)} DL` : null,
    m.githubStars != null ? `GitHub ${m.githubStars.toLocaleString('ja-JP')}★` : null,
    domesticTotal(m) != null
      ? `日本語の記事 ${domesticTotal(m)?.toLocaleString('ja-JP')}${m.zennComplete === false ? '+' : ''} 本`
      : null,
  ].filter(Boolean);

  const url = m.githubRepo
    ? `https://github.com/${m.githubRepo}`
    : (item.links[0]?.url ?? '');

  return [
    `${item.name}${item.what ? ` — ${item.what}` : ''}`,
    item.pitch,
    figures.join(' / '),
    url,
  ]
    .filter(Boolean)
    .join('\n');
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="radar__detail">
      <span className="radar__detail-label">{label}</span>
      <div className="radar__detail-body">{children}</div>
    </div>
  );
}

function Card({ item, date }: { item: RadarItem; date: string }) {
  return (
    <article className="radar">
      <div className="radar__head">
        <h3 className="radar__name">
          {item.name}
          {item.isNew && <span className="radar__new">NEW</span>}
        </h3>
        {item.what && <p className="radar__what">{item.what}</p>}
      </div>

      {item.pitch && (
        <div className="radar__pitch">
          <div className="radar__pitch-head">
            <span className="radar__pitch-label">紹介するときの一言</span>
            <CopyButton text={shareText(item)} label="数字ごとコピー" />
          </div>
          <p className="radar__pitch-body">{item.pitch}</p>
        </div>
      )}

      <Gap m={item.measure} />

      {item.insteadOf.length > 0 && (
        <Detail label="何の代わりになるか">
          <p className="radar__instead">{item.insteadOf.join(' / ')}</p>
        </Detail>
      )}

      {item.fitFor.length > 0 && (
        <Detail label="効く場面">
          <ul className="radar__list">
            {item.fitFor.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </Detail>
      )}

      {/* 紹介した後に自分が責任を負う類のことなので、畳まずに出す */}
      {item.caution && (
        <Detail label="紹介する前に知っておくこと">
          <p className="radar__caution">{item.caution}</p>
        </Detail>
      )}

      {/*
        * 「隠れた定番」の主張は、スター数と DL 数という外形の数字で支えている。
        * 「で、いま入れて動くのか」は数字では答えられないので、実行で確かめる。
        * この板は身元（npm パッケージ / GitHub リポジトリ）が必ず取れるので、
        * ほぼ全件にボタンが出る。
        */}
      <TrialSlot
        plan={item.trial}
        target={{ digestDate: date, itemId: item.id, title: item.name }}
      />

      {item.firstStep && (
        <Detail label="最初の一歩">
          <div className="radar__step">
            <code>{item.firstStep}</code>
            <CopyButton text={item.firstStep} label="コピー" />
          </div>
        </Detail>
      )}

      <details className="radar__evidence">
        <summary>
          判定の根拠（{item.evidence.length} 件）
          {item.foundVia && ' ・ 見つけた記事'}
        </summary>
        <ul className="radar__list">
          {item.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        {item.foundVia && (
          <p className="radar__via">
            見つけた記事:{' '}
            <a href={safeUrl(item.foundVia.url)} target="_blank" rel="noreferrer noopener">
              {item.foundVia.title}
            </a>
          </p>
        )}
        <p className="radar__measured">
          計測 {new Date(item.measure.measuredAt).toLocaleDateString('ja-JP')} ・ この語を最初に
          見かけたのは {item.firstSeenAt}
        </p>
      </details>

      <p className="radar__links">
        {item.links.map((l) => (
          <a key={l.url} href={safeUrl(l.url)} target="_blank" rel="noreferrer noopener">
            {l.label}
          </a>
        ))}
      </p>
    </article>
  );
}

export function RadarBoard({ items, date }: { items: RadarItem[]; date: string }) {
  return (
    <>
      {VERDICT_ORDER.map((verdict) => {
        const group = items.filter((i) => i.verdict === verdict);
        if (group.length === 0) return null;
        return (
          <section key={verdict} className="radar-group">
            <h2 className="section-title">
              {VERDICT_TITLES[verdict]}
              <span className="radar-group__count">{group.length}</span>
            </h2>
            <p className="section-lead">{VERDICT_LEADS[verdict]}</p>
            <div className="radar-list">
              {group.map((item) => (
                <Card key={item.id} item={item} date={date} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
