/**
 * 語の意味をその場で引く。
 *
 * 「これ何だっけ」を調べるのに、いちばん面倒なのは**アプリから出ること**
 * ——特にスマホでは、ブラウザに切り替えて戻ってくると読んでいた位置が失われる。
 * Wikipedia の API は CORS が開いていて直接叩けるので、説明だけを取ってきて
 * 窓の中に出す。それで足りなければ Google を開く導線を別に用意する。
 *
 * 日本語版に無い技術用語は多い（ComfyUI のような新しいツールは特に）。
 * 日本語で見つからなければ英語版を引き直す。
 */

export interface LookupResult {
  title: string;
  extract: string;
  url: string;
  lang: 'ja' | 'en';
}

/** 説明が長いと窓に入らない。頭のほうだけ出して、続きは元のページに任せる */
const MAX_CHARS = 420;

function trim(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS)}…` : flat;
}

interface Page {
  title?: string;
  extract?: string;
  /** disambiguation が入っていれば曖昧さ回避のページ */
  pageprops?: Record<string, unknown>;
}

async function ask(lang: 'ja' | 'en', extra: Record<string, string>, signal: AbortSignal): Promise<Page | null> {
  // origin=* は Wikipedia の API に CORS を許可させるための決まった書き方
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts|pageprops',
    exintro: '1',
    explaintext: '1',
    format: 'json',
    origin: '*',
    ...extra,
  });
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, { signal });
  if (!res.ok) return null;

  const json = (await res.json()) as { query?: { pages?: Record<string, Page> } };
  const page = Object.values(json.query?.pages ?? {})[0];
  // 項目が無い場合も pages は返る（missing 付きで本文が無い）ので、本文で判定する
  if (!page?.title || !page.extract?.trim()) return null;

  /*
   * 曖昧さ回避のページは意味を教えてくれない。
   *
   * 「MCP」「RCE」のような略語はこれに当たり、出しても "RCE may refer to:" や
   * 関係の無いほうの意味（Micro-Channel Plate）が並ぶだけで、読者が知りたかった
   * 意味とは限らない。**どれか分からない**のだから、当てずっぽうを出すより
   * 見つからなかったことにして Google へ送る。
   */
  if (page.pageprops && 'disambiguation' in page.pageprops) return null;
  return page;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s_\-–—・()（）「」"'.,]/g, '');
}

/**
 * 引いた項目が、本当にその語の説明かどうか。
 *
 * 全文検索は「1 件は必ず返す」ので、関係のない項目が先頭に来る。
 * 「Comfy MCP on local」で引くと "List of TCP and UDP port numbers" が返り、
 * それをそのまま意味として出すと**嘘を教える**ことになる。知らない語に対して
 * 嘘の説明が出るのは、何も出ないより悪い（下に Google の導線がある）。
 *
 * 見出しと語が字面で重なっているか、語のどれかが見出しの語と一致するときだけ通す。
 */
function looksRelated(title: string, query: string): boolean {
  const t = normalize(title);
  const q = normalize(query);
  if (!t || !q) return false;
  if (t.includes(q) || q.includes(t)) return true;

  const titleWords = title.toLowerCase().split(/[\s_\-–—・()（）]+/).filter((w) => w.length > 1);
  const queryWords = query.toLowerCase().split(/[\s_\-–—・()（）]+/).filter((w) => w.length > 1);
  // 見出しの主語（先頭の語）が、引いた語のどれかと一致していれば同じものを指している
  const head = titleWords[0];
  return head !== undefined && queryWords.includes(head);
}

function toResult(page: Page, lang: 'ja' | 'en'): LookupResult {
  const title = page.title ?? '';
  return {
    title,
    extract: trim(page.extract ?? ''),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    lang,
  };
}

/**
 * 項目名そのもので引く（リダイレクトは追う）。当たればそれが正解で、確かめる必要が無い。
 * 見つからなければ全文検索へ落ちるが、そちらは関係のある項目かどうかを確かめてから返す。
 */
export async function lookupTerm(query: string, signal: AbortSignal): Promise<LookupResult | null> {
  const langs = ['ja', 'en'] as const;
  const attempts: { lang: (typeof langs)[number]; params: Record<string, string>; verify: boolean }[] = [
    ...langs.map((lang) => ({ lang, params: { titles: query, redirects: '1' }, verify: false })),
    ...langs.map((lang) => ({
      lang,
      params: { generator: 'search', gsrsearch: query, gsrlimit: '1' },
      verify: true,
    })),
  ];

  for (const attempt of attempts) {
    if (signal.aborted) return null;
    try {
      const page = await ask(attempt.lang, attempt.params, signal);
      if (!page) continue;
      if (attempt.verify && !looksRelated(page.title ?? '', query)) continue;
      return toResult(page, attempt.lang);
    } catch (err) {
      // 中断は呼び出し側が知っているので、そこで止める
      if (err instanceof DOMException && err.name === 'AbortError') return null;
    }
  }
  return null;
}

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
