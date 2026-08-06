import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMonthLabel } from './format';

export function Chip({
  children,
  accent = false,
  title,
}: {
  children: ReactNode;
  accent?: boolean;
  title?: string;
}) {
  return (
    <span className={accent ? 'chip chip--accent' : 'chip'} title={title}>
      {children}
    </span>
  );
}


/**
 * 他のエンジニアと共通の話題になりうる印。
 *
 * 色だけに頼らないよう、記号と文字を併記している。
 * 判定根拠は収集側（はてブのホットエントリー掲載など）。
 */
export function BuzzChip() {
  return (
    <span
      className="chip chip--buzz"
      title="はてなブックマークのホットエントリー掲載、または同日のプラットフォーム内で明確に伸びている記事"
    >
      <span aria-hidden="true">◆</span> 話題
    </span>
  );
}

/** 全期間を選んだことを表す値。月の文字列と混ざらないようにしている */
export const ALL_MONTHS = '*';

/**
 * 対象月の選択。
 *
 * 読み込みの単位を表示の単位と一致させるためのもの。アーカイブが何年ぶんに
 * 増えても、既定では 1 ヶ月ぶんしか読まない。日数を添えているのは manifest だけで
 * 分かる情報で、インデックスを読まずに月の中身の量が伝わるため。
 */
export function MonthPicker({
  months,
  value,
  onChange,
  dayCounts,
  allowAll = false,
  label = '対象月',
}: {
  months: readonly string[];
  value: string;
  onChange: (month: string) => void;
  dayCounts: Map<string, number>;
  allowAll?: boolean;
  label?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {months.map((m) => {
        const days = dayCounts.get(m);
        return (
          <option key={m} value={m}>
            {formatMonthLabel(m)}
            {days ? `（${days}日）` : ''}
          </option>
        );
      })}
      {allowAll && <option value={ALL_MONTHS}>全期間（月ごとに順に読み込み）</option>}
    </select>
  );
}

export function Notice({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'error' | 'ok';
}) {
  const cls = kind === 'error' ? 'notice notice--error' : kind === 'ok' ? 'notice notice--ok' : 'notice';
  return <div className={cls}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card" style={{ padding: 22 }}>
          <div className="skeleton" style={{ height: 14, width: '35%', marginBottom: 14 }} />
          <div className="skeleton" style={{ height: 22, width: '80%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 12, marginBottom: 7 }} />
          <div className="skeleton" style={{ height: 12, marginBottom: 7 }} />
          <div className="skeleton" style={{ height: 12, width: '60%' }} />
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  }, [text]);

  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
      {copied ? '✓ コピーしました' : label}
    </button>
  );
}

/*
 * X の投稿画面に渡す本文の上限。
 * 日本語の文字は weight=2 で数えられ、URL は t.co 短縮後の 23 文字固定になるため、
 * 本文側の実際の余裕は 280 - 23 = 257 weight 程度。全角想定で安全側に丸めている。
 */
const TWEET_TEXT_MAX_CHARS = 100;

function truncateForTweet(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TWEET_TEXT_MAX_CHARS) return text;
  return chars.slice(0, TWEET_TEXT_MAX_CHARS - 1).join('') + '…';
}

/**
 * 共有リンクの取得（元記事URLのコピー）と、Xの投稿意図リンク。
 *
 * 投稿意図リンクは新しいタブでXの投稿画面を開くだけで、実際の投稿はしない。
 * OAuth連携なしで済み、本人が文面を最終確認してから投稿できる。
 */
export function ShareButtons({ url, tweetText }: { url: string; tweetText: string }) {
  const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(
    truncateForTweet(tweetText),
  )}&url=${encodeURIComponent(url)}`;
  return (
    <span className="share-buttons">
      <CopyButton text={url} label="🔗 共有リンクを取得" />
      <a className="btn btn--ghost btn--sm" href={intentUrl} target="_blank" rel="noreferrer noopener">
        𝕏 に投稿
      </a>
    </span>
  );
}

/** タグ（キーワード）を追加・削除できる入力欄 */
export function TagInput({
  values,
  onChange,
  placeholder = '入力して Enter',
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,、\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft('');
  };

  return (
    <div className="tag-input">
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className="tag">
          {v}
          <button
            type="button"
            aria-label={`${v} を削除`}
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}

/** 検索語をハイライトする */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const active = terms.map((t) => t.trim()).filter((t) => t.length >= 1);
  if (active.length === 0) return <>{text}</>;

  const escaped = active.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);

  return (
    <>
      {parts.map((part, i) =>
        active.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
          <mark key={i}>{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
