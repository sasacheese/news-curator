import type { MouseEvent, ReactNode } from 'react';
import { openQuickSearch } from './QuickSearch';
import type { Prerequisite } from './types';

/**
 * 本文中に出てくる前提知識の語に、その場で開ける印を付ける。
 *
 * 前提知識は畳んだ一覧としても下に出しているが、読んでいる途中で
 * 「この語が分からない」と思った瞬間に、そこで読めるのが一番早い。
 */

/**
 * popover は manual で開く。auto の light dismiss を使わない。
 *
 * auto だと、外側を叩いたとき「閉じる」と「その下の要素が押される」が同時に起きる。
 * カードの見出しやリンクの上にたまたま指が落ちただけで別のカードが開いてしまい、
 * 読んでいた場所を失う。閉じる操作は**閉じるだけ**であってほしい。
 *
 * そこで manual にして、開いている間の外側の押下を capture 段階で捕まえ、
 * その場で止めてから閉じる。Esc と「もう一度同じ語を叩いたら閉じる」は
 * auto が面倒を見てくれていたぶんなので、こちらで持ち直す。
 */

/** 閉じたあと、同じ操作から続けて飛んでくるイベントを飲む期間 */
const SWALLOW_MS = 500;
let swallowUntil = 0;

/**
 * pointerdown を止めても click は別に飛ぶ（既定動作の抑止では消えない）。
 * 閉じた直後の短い間だけ、続きのイベントも capture 段階で飲む。
 */
function swallowGuard(e: Event): void {
  if (Date.now() > swallowUntil) {
    document.removeEventListener('click', swallowGuard, true);
    document.removeEventListener('mouseup', swallowGuard, true);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function beginSwallow(): void {
  swallowUntil = Date.now() + SWALLOW_MS;
  document.addEventListener('click', swallowGuard, true);
  document.addEventListener('mouseup', swallowGuard, true);
}

/** 開いている間だけ、外側の押下と Esc を受ける */
function armDismiss(pop: HTMLElement): void {
  const onPointerDown = (e: Event) => {
    if (pop.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    beginSwallow();
    pop.hidePopover();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    pop.hidePopover();
  };
  const onToggle = (e: Event) => {
    if ((e as Event & { newState?: string }).newState === 'open') return;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    pop.removeEventListener('toggle', onToggle);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  pop.addEventListener('toggle', onToggle);
}

/**
 * 印を叩いたとき。
 *
 * 既定動作を止めるのは、印がカードの見出し（`<summary>` の中）にも付くため。
 * summary の中のクリックは details の開閉という既定動作を持っていて、これは
 * 伝播を止めても消えない。止めたうえで自分で開けば、語を叩いてもカードは
 * 畳んだまま説明だけが開く。
 */
function onTermClick(e: MouseEvent, id: string): void {
  e.preventDefault();
  e.stopPropagation();

  const pop = document.getElementById(id);
  if (!pop) return;
  const wasOpen = pop.matches(':popover-open');

  // manual は他を勝手に閉じないので、開く前に自分で片付ける
  for (const other of document.querySelectorAll<HTMLElement>('.anno__pop:popover-open')) {
    other.hidePopover();
  }
  if (wasOpen) return; // 同じ語をもう一度叩いたら閉じるだけ

  pop.showPopover();
  armDismiss(pop);
}

/** 語そのものと、それを開く印。表示する文字は語と別に渡せる */
function Term({
  id,
  prerequisite,
  children,
}: {
  id: string;
  prerequisite: Prerequisite;
  children: ReactNode;
}) {
  return (
    <span className="anno">
      <button type="button" className="anno__term" onClick={(e) => onTermClick(e, id)}>
        {children}
      </button>
      <span className="anno__pop" id={id} popover="manual">
        <span className="anno__pop-term">{prerequisite.term}</span>
        {prerequisite.stumblingPoint && (
          <span className="anno__pop-stumble">{prerequisite.stumblingPoint}</span>
        )}
        <span className="anno__pop-body">{prerequisite.explanation}</span>
        {/*
          * ここの解説は「この記事を読むために足りないぶん」なので、語そのものを
          * まだ知らない人には届かないことがある。外へ出ずに引き直せる口を置く。
          */}
        <span className="anno__pop-foot">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              const el = document.getElementById(id);
              el?.hidePopover();
              openQuickSearch(prerequisite.term);
            }}
          >
            ⌕ この語を調べる
          </button>
        </span>
      </span>
    </span>
  );
}

/** 長い語から先に当てる。「React Server Components」が「React」で切られないように */
function sortedTerms(prerequisites: readonly Prerequisite[]): Prerequisite[] {
  return [...prerequisites]
    .filter((p) => p.term.trim())
    .sort((a, b) => b.term.length - a.term.length);
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
      <Term id={id} prerequisite={hit.term} key={id}>
        {hit.term.term}
      </Term>,
    );
    rest = rest.slice(hit.at + hit.term.term.length);
  }

  if (rest.length > 0) nodes.push(rest);
  return <>{nodes}</>;
}

/**
 * カードを開かなくても読める用語の並び。
 *
 * 説明は前提知識として全部持っているのに、これまではカードを開いて本文に
 * 行き当たるまで出てこなかった。畳んだ状態で見出しに知らないツール名があると
 * 「なんの話か」が分からないまま次のカードへ送られる——それが一番起きてほしくない。
 * 見出しに出ている語は印が付くので、ここではそれ以外の語を並べる。
 */
export function TermChips({
  prerequisites,
  idPrefix,
  /** すでに印が付いている文（見出しなど）。ここに出ている語は繰り返さない */
  shownIn = '',
  max = 4,
}: {
  prerequisites: readonly Prerequisite[];
  idPrefix: string;
  shownIn?: string;
  max?: number;
}) {
  const terms = prerequisites
    .filter((p) => p.term.trim() && !shownIn.includes(p.term))
    .slice(0, max);
  if (terms.length === 0) return null;

  return (
    <div className="terms">
      <span className="terms__label">用語</span>
      {terms.map((p, i) => (
        <Term id={`pop-${idPrefix}-${i}`} prerequisite={p} key={p.term}>
          {p.term}
        </Term>
      ))}
    </div>
  );
}
