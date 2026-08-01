import { safeUrl } from './format';
import type { ReleaseAlso, ReleaseItem, ReleaseKind } from './types';

/**
 * リリース情報。
 *
 * ベスト3と違って順位をつけず全件出す。知っているか知らないかだけで差が出る
 * 種類の情報なので、拾い読みできる密度を優先している。
 * 種類ごとにまとめ、新モデル・メジャー版を上に、パッチを下に置く。
 */

const KIND_LABELS: Record<ReleaseKind, string> = {
  'ai-model': 'AIモデル',
  major: 'メジャー / 新規公開',
  service: 'サービス',
  minor: '機能追加',
  patch: 'パッチ',
};

/**
 * 手元を更新する判断が要るものを上に。SaaS の機能追加（service）は件数が多く、
 * 途中に置くとライブラリ関連が分断されて patch のライブラリが埋もれるので最後に置く。
 */
const KIND_ORDER: ReleaseKind[] = ['ai-model', 'major', 'minor', 'patch', 'service'];

/** 旧データ（文字列配列）も受けられるようにそろえる */
function normalizeAlso(v: string | ReleaseAlso): { label: string; url: string | null } {
  return typeof v === 'string' ? { label: v, url: null } : { label: v.label, url: v.url };
}

export function ReleaseList({
  releases,
  highlightIds,
}: {
  releases: ReleaseItem[];
  /** ベスト3にも入っているもの。重複に見えないよう印をつける */
  highlightIds: ReadonlySet<string>;
}) {
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: releases.filter((r) => r.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="releases">
      {groups.map((group) => (
        <section className="rel-group" key={group.kind}>
          <h3 className={`rel-group__title rel-group__title--${group.kind}`}>
            {KIND_LABELS[group.kind]}
            <span className="rel-group__count">{group.items.length}</span>
          </h3>
          <ul className="rel-list">
            {group.items.map((r) => (
              <li className="rel" key={r.id}>
                <p className="rel__head">
                  <a
                    className="rel__product"
                    href={safeUrl(r.url)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {r.product}
                  </a>
                  {r.version && <code className="rel__version">{r.version}</code>}
                  {highlightIds.has(r.id) && <span className="rel__badge">ベスト3で詳説</span>}
                </p>
                {r.what && <p className="rel__what">{r.what}</p>}
                {r.summary && <p className="rel__summary">{r.summary}</p>}
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
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
