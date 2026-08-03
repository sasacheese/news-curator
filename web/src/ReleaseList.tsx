import { FeedbackButtons } from './FeedbackButtons';
import { safeUrl } from './format';
import type { ReleaseAlso, ReleaseImpact, ReleaseItem, ReleaseKind } from './types';

/**
 * リリース情報。
 *
 * 順位はつけず全件出す。知っているか知らないかだけで差が出る種類の情報なので、
 * 拾い読みできる密度を優先している。
 *
 * 並べる軸は impact（読者に何が起きるか）。以前は kind（メジャー/マイナー/
 * パッチ/サービス）で並べていたが、これは仕様上の分類で読み手の関心と
 * 一致していなかった。実測 27 件では service 15 件の中に
 * 「1 サンドボックスで複数エージェント実行」と「Server-Timing ヘッダーの通過」が
 * 同居し、minor のほうが「できるようになる」打率が高かった（4 件中 3 件）。
 */

const IMPACT_ORDER: ReleaseImpact[] = ['unlocks', 'security', 'improves', 'chore'];

const IMPACT_LABELS: Record<ReleaseImpact, string> = {
  unlocks: 'できるようになったこと',
  security: 'ふさがれた脆弱性',
  improves: '速く・楽になったこと',
  chore: '修正のみ',
};

const IMPACT_LEADS: Record<ReleaseImpact, string | null> = {
  unlocks: null,
  security: null,
  improves: null,
  // 畳んでいる理由を書いておく。隠しているように見せない
  chore: '新しくできることが増えないものです。使っているものがあれば上げておくだけで足ります。',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: '緊急',
  high: '重要',
  medium: '警告',
  low: '注意',
};

/**
 * impact を持たない日のデータを寄せる。
 * この機能より前に生成した日は kind しか無いので、最低限の対応を取る。
 */
function impactOf(r: ReleaseItem): ReleaseImpact {
  if (r.impact) return r.impact;
  if (r.kind === 'patch') return 'chore';
  if (r.kind === 'ai-model' || r.kind === 'major') return 'unlocks';
  return 'improves';
}

/** 旧データ（文字列配列）も受けられるようにそろえる */
function normalizeAlso(v: string | ReleaseAlso): { label: string; url: string | null } {
  return typeof v === 'string' ? { label: v, url: null } : { label: v.label, url: v.url };
}

/** 仕様上の分類。impact が主軸になったので、補足として小さく添えるだけにする */
const KIND_LABELS: Record<ReleaseKind, string> = {
  'ai-model': 'AIモデル',
  major: 'メジャー',
  service: 'サービス',
  minor: '機能追加',
  patch: 'パッチ',
};

function Row({
  r,
  highlighted,
  digestDate,
}: {
  r: ReleaseItem;
  highlighted: boolean;
  digestDate: string;
}) {
  const advisory = r.advisory;
  return (
    <li className="rel">
      <p className="rel__head">
        <a className="rel__product" href={safeUrl(r.url)} target="_blank" rel="noreferrer noopener">
          {r.product}
        </a>
        {r.version && <code className="rel__version">{r.version}</code>}
        {advisory && (
          <span className={`rel__sev rel__sev--${advisory.severity}`}>
            {SEVERITY_LABELS[advisory.severity] ?? advisory.severity}
            {advisory.cvss != null && <> {advisory.cvss.toFixed(1)}</>}
          </span>
        )}
        <span className="rel__kind">{KIND_LABELS[r.kind]}</span>
        {highlighted && <span className="rel__badge">ベスト3で詳説</span>}
      </p>

      {r.what && <p className="rel__what">{r.what}</p>}

      {/* 一番読みたい 1 行なので、要約より前に、目立つ形で置く */}
      {r.unlock && (
        <p className="rel__unlock">
          <span className="rel__unlock-mark" aria-hidden="true">
            →
          </span>
          {r.unlock}
        </p>
      )}

      {/* 変化の大きさは形容詞では伝わらないので、対にして見せる */}
      {r.change && (
        <p className="rel__change">
          <span className="rel__change-side">
            <span className="rel__change-label">今まで</span>
            {r.change.before}
          </span>
          <span className="rel__change-arrow" aria-hidden="true">
            →
          </span>
          <span className="rel__change-side rel__change-side--after">
            <span className="rel__change-label">これから</span>
            {r.change.after}
          </span>
        </p>
      )}

      {/* 「スマホでも使えるようになった」を一目で分かるようにする */}
      {r.scope && r.scope.length > 0 && (
        <p className="rel__scope">
          {r.scope.map((s) => (
            <span className="rel__scope-tag" key={s}>
              {s}
            </span>
          ))}
          <span className="rel__scope-note">に新たに対応</span>
        </p>
      )}

      {r.summary && <p className="rel__summary">{r.summary}</p>}

      {advisory && (
        <p className="rel__advisory">
          {advisory.cveId ?? advisory.ghsaId} · {advisory.packageName}
          {advisory.patchedVersion ? (
            <>
              {' '}
              · <strong>{advisory.patchedVersion}</strong> で修正
            </>
          ) : (
            <> · 修正版なし</>
          )}
        </p>
      )}

      {r.alsoReleased.length > 0 && (
        <details className="rel__also">
          <summary>同じ製品の他 {r.alsoReleased.length} 件</summary>
          <ul>
            {r.alsoReleased.map(normalizeAlso).map((a) => (
              <li key={a.url ?? a.label}>
                {a.url ? (
                  <a href={safeUrl(a.url)} target="_blank" rel="noreferrer noopener">
                    {a.label}
                  </a>
                ) : (
                  <code>{a.label}</code>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <FeedbackButtons
        target={{
          id: r.id,
          tier: 'release',
          digestDate,
          source: '(release)',
          sourceLabel: r.sourceLabel,
          title: r.product,
          url: r.url,
          category: KIND_LABELS[r.kind],
        }}
      />
    </li>
  );
}

export function ReleaseList({
  releases,
  highlightIds,
  digestDate,
}: {
  releases: ReleaseItem[];
  /** ベスト3にも入っているもの。重複に見えないよう印をつける */
  highlightIds: ReadonlySet<string>;
  digestDate: string;
}) {
  const groups = IMPACT_ORDER.map((impact) => ({
    impact,
    items: releases.filter((r) => impactOf(r) === impact),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="releases">
      {groups.map((group) => {
        const rows = (
          <ul className="rel-list">
            {group.items.map((r) => (
              <Row key={r.id} r={r} highlighted={highlightIds.has(r.id)} digestDate={digestDate} />
            ))}
          </ul>
        );

        /*
         * 修正のみは畳む。「バグ修正と信頼性向上を実施」に画面を使う価値はないが、
         * 使っているライブラリの回帰修正は当人には重要なので、消さずに畳む。
         */
        if (group.impact === 'chore') {
          return (
            <details className="rel-group rel-group--folded" key={group.impact}>
              <summary className="rel-group__summary">
                {IMPACT_LABELS.chore}
                <span className="rel-group__count">{group.items.length}</span>
              </summary>
              {IMPACT_LEADS.chore && <p className="rel-group__lead">{IMPACT_LEADS.chore}</p>}
              {rows}
            </details>
          );
        }

        return (
          <section className="rel-group" key={group.impact}>
            <h3 className={`rel-group__title rel-group__title--${group.impact}`}>
              {IMPACT_LABELS[group.impact]}
              <span className="rel-group__count">{group.items.length}</span>
            </h3>
            {rows}
          </section>
        );
      })}
    </div>
  );
}
