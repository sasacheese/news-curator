import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * ログ
 * ------------------------------------------------------------------ */

const started = Date.now();

function stamp(): string {
  const s = ((Date.now() - started) / 1000).toFixed(1).padStart(6, ' ');
  return `[${s}s]`;
}

export const log = {
  info: (...args: unknown[]) => console.log(stamp(), ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), '⚠ ', ...args),
  error: (...args: unknown[]) => console.error(stamp(), '✖ ', ...args),
  step: (title: string) => console.log(`\n${stamp()} ── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`),
};

/* ------------------------------------------------------------------ *
 * 時刻（JST 固定）
 * ------------------------------------------------------------------ */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC の Date から JST の壁時計としての各要素を得る */
export function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

/** JST の YYYY-MM-DD */
export function jstDateString(d: Date): string {
  const { year, month, day } = jstParts(d);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** JST の YYYY-MM */
export function jstMonthString(d: Date): string {
  return jstDateString(d).slice(0, 7);
}

/** JST の指定日 hh:00 を UTC の Date として返す */
export function jstDateAtHour(dateStr: string, hour: number): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hour, 0, 0) - JST_OFFSET_MS);
}

/**
 * ダイジェスト対象の 24 時間ウィンドウを求める。
 * 「当日 7:00 JST まで」の 24 時間 = 「前日 7:00 JST 〜 当日 7:00 JST」。
 */
export function resolveWindow(now: Date, explicitDate?: string, cutoffHour = 7) {
  // 当日 7:00 前に走った場合は前日ぶんを対象にする
  let date = explicitDate;
  if (!date) {
    const { hour } = jstParts(now);
    const base = hour < cutoffHour ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : now;
    date = jstDateString(base);
  }
  const end = jstDateAtHour(date, cutoffHour);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { date, start, end };
}

export function formatJst(d: Date): string {
  const p = jstParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} JST`;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const USER_AGENT =
  'news-curator/1.0 (+https://github.com/sasacheese/news-curator) personal tech digest bot';

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  retries?: number;
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 20_000, headers = {}, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt + Math.floor(Math.random() * 300));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 並列数を制限して map する */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 失敗しても全体を止めないラッパー */
export async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * テキスト
 * ------------------------------------------------------------------ */

/*
 * \0 で連結してからハッシュする。区切りに空白を使うと
 * ['a b','c'] と ['a','b c'] が同じ id になってしまう。
 *
 * エスケープ表記で書くこと。生の NUL バイトを埋めると git がこのファイルを
 * バイナリと判定し、差分が「Bin 9074 -> 10246 bytes」になって読めなくなる。
 */
export function hashId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/**
 * 実体参照をほどく。
 *
 * 名前付きだけでなく数値文字参照（&#x306F; / &#12354;）も対象にする。
 * 一部のフィードは日本語を丸ごと数値文字参照で書いてくるので、
 * ここを取りこぼすと本文が「&#x306F;&#x3066;&#x306A;」のまま残る。
 *
 * &amp; は最後に処理する。先に解くと「&amp;lt;」が「<」まで戻ってしまう。
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      safeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(nbsp|lt|gt|quot|apos);/g, (_, name: string) => NAMED_ENTITIES[name] ?? _)
    .replace(/&amp;/g, '&');
}

/** 不正なコードポイントで String.fromCodePoint が投げるのを防ぐ */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  // サロゲート単体は文字にならない
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}

/** HTML からタグを落としてプレーンテキストにする（簡易） */
export function stripHtml(html: string): string {
  // 実体参照はタグを落とした後にほどく。先にほどくと &lt;script&gt; が
  // タグとして除去され、文字列として書かれていた内容が消える。
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown からリンク記法などを落として素のテキストに近づける */
export function stripMarkdown(md: string): string {
  return decodeEntities(
    md
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/`([^`]+)`/g, '$1')
      // README やリリースノートには生の HTML（バッジ・中央寄せ）が混ざることが多い。
      // 記法を落とす前にタグを除去しないと、"<" だけが残って読めなくなる。
      .replace(/<[^>\n]{1,300}>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '・')
      .replace(/[*_~]/g, ''),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function detectLang(text: string): 'ja' | 'en' | 'unknown' {
  if (!text) return 'unknown';
  const ja = (text.match(/[぀-ヿ一-龯]/g) ?? []).length;
  if (ja > text.length * 0.04) return 'ja';
  if (/[a-z]/i.test(text)) return 'en';
  return 'unknown';
}

/** URL を比較しやすい形に正規化（トラッキングパラメータ除去など） */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|ref_src|source|fbclid|gclid|mc_cid|mc_eid|__twitter)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * http/https の URL か。
 * 外部 API・RSS の link は信用できないので、`javascript:` などを保存前に落とす。
 */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 「まだ見たことがない固有名詞」の判定に使う語を切り出す。
 *
 * 新しさとキーワード一致は逆を向く——新しいツールは、名前がまだどの語彙にも
 * 無いから新しい。だから「関心トピックに一致するか」ではなく「過去のダイジェストに
 * 出てきた語かどうか」で測る。取りこぼしより取りすぎのほうが安全なので、
 * ASCII 語とカタカナ語だけを粗く拾い、ありふれた語だけ落とす。
 */
const COMMON_TERMS = new Set([
  'this', 'that', 'with', 'from', 'have', 'about', 'your', 'what', 'when', 'how',
  'why', 'the', 'and', 'for', 'not', 'you', 'are', 'was', 'can', 'will', 'new',
  'using', 'use', 'used', 'make', 'made', 'build', 'built', 'introduction',
  'guide', 'tutorial', 'part', 'update', 'updates', 'release', 'version',
  'https', 'http', 'www', 'com', 'github', 'json', 'html', 'code',
  'エンジニア', 'アプリ', 'システム', 'サービス', 'ツール', 'データ', 'ファイル',
  'プロジェクト', 'コード', 'テスト', 'サーバー', 'クライアント', 'ユーザー',
  'メソッド', 'パターン', 'ライブラリ', 'フレームワーク', 'アップデート', 'リリース',
]);

export function extractTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z][a-z0-9.\-_]{2,}/g) ?? [];
  // カタカナの連なりは、そのまま製品名であることが多い
  const katakana = text.match(/[ァ-ヴ][ァ-ヴー]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const t of [...ascii, ...katakana]) {
    const term = t.replace(/[.\-_]+$/, '');
    if (term.length < 3 || COMMON_TERMS.has(term)) continue;
    out.add(term);
  }
  return [...out];
}

/** タイトルの近似重複判定用のキー */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～、-〜「」『』・…]/g, '')
    .slice(0, 40);
}
