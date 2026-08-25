import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from './App';
import { loadIndexByMonth, loadIndexShard } from './api';
import { Highlight } from './components';
import { displayTitle, formatDateShort, safeUrl } from './format';
import { type LookupResult, googleUrl, lookupTerm } from './lookup';
import { searchEntries, tokenize } from './search';
import type { IndexEntry, Manifest } from './types';

/**
 * 読みながら「これ何だっけ」を引くための窓。
 *
 * 元はサイト内検索の小さい版だったが、読んでいて手が止まるのは
 * 「この語を知らない」ときで、そのとき欲しいのは過去のダイジェストではなく
 * **語の意味**である。特にスマホでは、調べるためにブラウザへ切り替えて
 * 戻ってくると読んでいた位置が失われる——アプリから出さずに済ませたい。
 *
 * そこでこの窓は 2 つを同時に出す。
 *   ・語の説明（Wikipedia から取ってその場に出す）
 *   ・その語が出てくる過去のダイジェスト（サイト内）
 * どちらでも足りなければ、Google と Wikipedia を開く導線を下に置く。
 *
 * 索引は開いたときに初めて読む。読む前から抱えても、開かない人には無駄になる。
 */

const OPEN_EVENT = 'quicksearch:open';
const RESULT_LIMIT = 8;
/** 打っている途中で毎回引かない。手が止まってから引く */
const LOOKUP_DELAY_MS = 400;

/** どこからでも開ける。語を渡すと、その語を引いた状態で開く */
export function openQuickSearch(query = ''): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: query }));
}

export function QuickSearch({ manifest }: { manifest: Manifest | null }) {
  const months = manifest?.months ?? [];
  const latestMonth = months[0] ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);
  const [all, setAll] = useState(false);
  const [loadedMonths, setLoadedMonths] = useState(0);
  const [active, setActive] = useState(0);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [looking, setLooking] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 開ける。状態を立てるだけでなく、その場で dialog も開く。
   *
   * 「状態が true なら開いているはず」に寄せると、実体だけ閉じていたときに
   * 二度と開かなくなる（setOpen(true) が同じ値で何も起こさないため）。
   * dialog がいま開いているかは実体に聞けるので、そちらを見て開く。
   */
  const openNow = useCallback((next?: string) => {
    if (next) setQuery(next);
    setActive(0);
    setOpen(true);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.select();
  }, []);

  const closeNow = useCallback(() => {
    dialogRef.current?.close();
    setOpen(false);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => openNow((e as CustomEvent<string>).detail ?? '');
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [openNow]);

  /*
   * Esc や外側クリックで閉じたことを状態へ戻す。
   *
   * dialog の close はバブルしないので、React の onClose 属性では拾えない
   * （React はルートに 1 つ張った listener で受けるため）。要素に直接張る。
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => setOpen(false);
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, []);

  // 初回に開いたときだけ索引を読む。以後は開き直しても読み直さない
  useEffect(() => {
    if (!open || !latestMonth || entries !== null) return;
    let cancelled = false;
    loadIndexShard(latestMonth, latestMonth).then(
      (e) => !cancelled && setEntries(e),
      () => !cancelled && setEntries([]),
    );
    return () => {
      cancelled = true;
    };
  }, [open, latestMonth, entries]);

  const terms = useMemo(() => tokenize(query), [query]);

  // 語の説明を引く。打つたびに投げないよう少し待ち、前の要求は捨てる
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setLookup(null);
      setLooking(false);
      return;
    }
    const controller = new AbortController();
    setLooking(true);
    const timer = setTimeout(() => {
      lookupTerm(q, controller.signal).then(
        (hit) => {
          if (controller.signal.aborted) return;
          setLookup(hit);
          setLooking(false);
        },
        () => !controller.signal.aborted && setLooking(false),
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query]);

  /** 全期間へ広げる。読めた月から順に足すので、待たずに結果が増えていく */
  const expandAll = useCallback(() => {
    if (all || !latestMonth) return;
    setAll(true);
    setLoadedMonths(0);
    const acc: IndexEntry[] = [];
    void loadIndexByMonth(months, latestMonth, (_m, shard) => {
      acc.push(...shard);
      setEntries([...acc]);
      setLoadedMonths((n) => n + 1);
    });
  }, [all, latestMonth, months]);

  const results = useMemo(
    () =>
      entries && terms.length > 0 ? searchEntries(entries, terms, { limit: RESULT_LIMIT }) : [],
    [entries, terms],
  );

  useEffect(() => setActive(0), [query]);

  const toFullSearch = useCallback(() => {
    closeNow();
    navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
  }, [closeNow, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + delta + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // 候補が出ているなら開く。出ていない（語が短いなど）なら検索画面へ送る
      const hit = results[active];
      if (!hit) return toFullSearch();
      window.open(safeUrl(hit.url), '_blank', 'noreferrer,noopener');
    }
  };

  const hasQuery = query.trim().length > 0;

  return (
    <dialog
      className="qs"
      ref={dialogRef}
      /* 背景（dialog 本体の余白）を叩いたら閉じる。中身は .qs__panel が受け止める */
      onClick={(e) => e.target === dialogRef.current && closeNow()}
    >
      <div className="qs__panel" onKeyDown={onKeyDown}>
        <div className="qs__bar">
          <span className="qs__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            type="search"
            className="qs__input"
            value={query}
            placeholder="調べる（例: ComfyUI / MCP）"
            aria-label="語を調べる"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="qs__close" onClick={closeNow} aria-label="閉じる">
            Esc
          </button>
        </div>

        {!hasQuery ? (
          <p className="qs__hint">
            語を入れると、意味とこのサイト内の記事をまとめて出します。
            <br />
            本文を選んで「調べる」を押しても開きます。
          </p>
        ) : (
          /* 広い画面では左右に分ける。意味と実例を見比べながら読めるようにする */
          <div className="qs__cols">
            <section className="qs__col">
              <h2 className="qs__coltitle">意味</h2>
              {looking ? (
                <p className="qs__hint">調べています…</p>
              ) : lookup ? (
                <div className="qs__def">
                  <p className="qs__def-term">
                    {lookup.title}
                    {lookup.lang === 'en' && <span className="qs__def-lang">英語版</span>}
                  </p>
                  <p className="qs__def-body">{lookup.extract}</p>
                  <a
                    className="qs__def-src"
                    href={lookup.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Wikipedia で続きを読む ↗
                  </a>
                </div>
              ) : (
                <p className="qs__hint">
                  百科事典には項目がありませんでした。新しいツール名だと出ないことが多いので、
                  下の「Google で調べる」を使ってください。
                </p>
              )}
              <a
                className="btn btn--sm qs__google"
                href={googleUrl(query)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Google で調べる ↗
              </a>
            </section>

            <section className="qs__col">
              <h2 className="qs__coltitle">
                このサイトの記事
                {results.length > 0 && <span className="qs__colcount">{results.length}</span>}
              </h2>
              {entries === null ? (
                <p className="qs__hint">索引を読み込み中…</p>
              ) : results.length === 0 ? (
                <p className="qs__hint">
                  {all ? '該当する記事がありません。' : 'この月には見つかりませんでした。'}
                </p>
              ) : (
                <ul className="qs__list">
                  {results.map((entry, i) => (
                    <li key={`${entry.date}-${entry.id}`}>
                      <a
                        className={i === active ? 'qs__hit qs__hit--active' : 'qs__hit'}
                        href={safeUrl(entry.url)}
                        target="_blank"
                        rel="noreferrer noopener"
                        onMouseEnter={() => setActive(i)}
                      >
                        <span className="qs__hit-title">
                          <Highlight text={displayTitle(entry)} terms={terms} />
                        </span>
                        <span className="qs__hit-meta">
                          {formatDateShort(entry.date)} · {entry.sourceLabel} · {entry.category}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <div className="qs__foot">
          {all ? (
            <span className="faint">
              全期間
              {loadedMonths < months.length
                ? ` を読み込み中 ${loadedMonths}/${months.length} ヶ月`
                : ''}
            </span>
          ) : (
            <button type="button" className="btn btn--sm" onClick={expandAll}>
              全期間に広げる
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={toFullSearch}>
            検索画面で開く →
          </button>
        </div>
      </div>
    </dialog>
  );
}
