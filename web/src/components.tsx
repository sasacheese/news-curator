import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMonthLabel, safeUrl } from './format';
import type { Figure } from './types';

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

/**
 * 「3行で要約」。
 *
 * 専門用語を一切使わずに、記事が何を言っているかだけを 3 行で置く。畳んだカードでも
 * 一覧でもこれが出るので、**開かなくても話が分かる**ことをここが引き受ける。
 * 対になっているのはカード内の要約（summary）で、あちらは記事の語彙をそのまま使って
 * 詳しく書く（分からない語は前提知識としてその場で開ける）。
 *
 * 以前は「読みどころ」という 1 本の文だったが、名前と中身が合っておらず——
 * 実際に返ってきていたのは要約——カード内の要約と二重に読ませていた。
 * 平易さと詳しさで役割を割り直したのがこの形。
 */
export function Takeaways({ lines, compact }: { lines: string[]; compact?: boolean }) {
  if (lines.length === 0) return null;
  return (
    <div className={compact ? 'takeaways takeaways--compact' : 'takeaways'}>
      <span className="takeaways__label">3行で要約</span>
      <ul className="takeaways__list">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 元記事のサムネイル。
 *
 * 出るのは配信元が置いた本物の画像があるときだけで、出ない日のほうが多い
 * （収集側でタイトルを描いただけの自動生成カードを落としているため）。
 * **無いことが既定**なので、カードの他の要素はこれが無い前提で並んでいる。
 *
 * 画像はサイトに持たず配信元を直接参照する。つまり向こうが消せばここも消えるので、
 * 失敗を呼び出し側に返して、画像の列ごと畳めるようにしている——画像だけ消して
 * 列が残ると、右に空白の帯が出たままになる。この状態を自分で持たないのはそのため。
 * 見出しと 3 行要約が同じことをすでに伝えているので、読み上げ上は装飾として扱う。
 */
export function Thumbnail({ src, onFailed }: { src: string; onFailed: () => void }) {
  return (
    <img
      className="card__thumb"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      /* 読者がどのダイジェストを開いたかを配信元に渡さない */
      referrerPolicy="no-referrer"
      onError={onFailed}
    />
  );
}

/**
 * 解説の中で引用した、記事内の画像。
 *
 * サムネイル（Thumbnail）と役割が違う。あちらは「どの記事か」を示すだけなので装飾として
 * 扱い alt を空にしているが、こちらは**読むための画像**——実行結果や構成図や計測グラフ——
 * なので、キャプションを本文として先に読ませ、alt も記事側のものを渡す。
 * 引用しない記事のほうが多いので、この枠が出ない日が既定。
 *
 * 画像は配信元を直接参照している。向こうが消せばここも消えるので、落ちた 1 枚だけを
 * 畳む（枠だけ残るとキャプションが何も指さない）。全部落ちたら見出しごと消える。
 */
export function Figures({ figures }: { figures: Figure[] }) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const shown = figures.filter((f) => safeUrl(f.url) && !failed.includes(f.url));
  if (shown.length === 0) return null;
  return (
    <div className="figquotes">
      <span className="figquotes__label">記事の中の画像</span>
      {shown.map((f) => (
        <figure className="figquote" key={f.url}>
          <img
            className="figquote__img"
            src={f.url}
            alt={f.alt || f.caption}
            loading="lazy"
            decoding="async"
            /* 読者がどのダイジェストを開いたかを配信元に渡さない */
            referrerPolicy="no-referrer"
            onError={() => setFailed((prev) => [...prev, f.url])}
          />
          <figcaption className="figquote__caption">{f.caption}</figcaption>
        </figure>
      ))}
    </div>
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
