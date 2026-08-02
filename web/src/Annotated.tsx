import type { ReactNode } from 'react';
import type { Prerequisite } from './types';

/**
 * 本文中に出てくる前提知識の語に、その場で開ける印を付ける。
 *
 * 前提知識は畳んだ一覧としても下に出しているが、読んでいる途中で
 * 「この語が分からない」と思った瞬間に、そこで読めるのが一番早い。
 *
 * ネイティブの Popover API（popover 属性 + popovertarget）を使う。
 * ライブラリを足さずに、Esc で閉じる・外側クリックで閉じる・
 * フォーカス管理まで面倒を見てくれる。
 */

/** 長い語から先に当てる。「React Server Components」が「React」で切られないように */
function sortedTerms(prerequisites: readonly Prerequisite[]): Prerequisite[] {
  return [...prerequisites].filter((p) => p.term.trim()).sort((a, b) => b.term.length - a.term.length);
}

export function Annotated({
  text,
  prerequisites,
  idPrefix,
}: {
  text: string;
  prerequisites: readonly Prerequisite[];
  /** popover の id を一意にするための接頭辞。カード内で重複させない */
  idPrefix: string;
}) {
  const terms = sortedTerms(prerequisites);
  if (terms.length === 0) return <>{text}</>;

  const nodes: ReactNode[] = [];
  // 同じ語が何度も出てきたら最初の 1 回だけ印を付ける。全部に付けると本文が読めない
  const used = new Set<string>();
  let rest = text;
  let guard = 0;

  while (rest.length > 0 && guard++ < 200) {
    let hit: { term: Prerequisite; at: number } | null = null;
    for (const term of terms) {
      if (used.has(term.term)) continue;
      const at = rest.indexOf(term.term);
      if (at >= 0 && (hit === null || at < hit.at)) hit = { term, at };
    }
    if (!hit) break;

    if (hit.at > 0) nodes.push(rest.slice(0, hit.at));
    used.add(hit.term.term);
    const id = `pop-${idPrefix}-${used.size}`;
    nodes.push(
      <span className="anno" key={id}>
        <button type="button" className="anno__term" popoverTarget={id}>
          {hit.term.term}
        </button>
        <span className="anno__pop" id={id} popover="auto">
          <span className="anno__pop-term">{hit.term.term}</span>
          {hit.term.stumblingPoint && (
            <span className="anno__pop-stumble">{hit.term.stumblingPoint}</span>
          )}
          <span className="anno__pop-body">{hit.term.explanation}</span>
        </span>
      </span>,
    );
    rest = rest.slice(hit.at + hit.term.term.length);
  }

  if (rest.length > 0) nodes.push(rest);
  return <>{nodes}</>;
}
