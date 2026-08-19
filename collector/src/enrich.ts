import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { type BodyImage, pickBodyImages, resolveImage, verifyBodyImages } from './image.js';
import { fetchGithubReadme, fetchHatenaCounts, fetchZennBodyHtml } from './sources.js';
import type { RawItem, SourceKind } from './types.js';
import { fetchText, log, mapLimit, safe, stripHtml, truncate } from './util.js';

/**
 * 収集時点で一次情報の本文が手に入っているソース。
 * これらを HTML から再取得すると、かえってページの UI 部品を拾ってしまう。
 */
const AUTHORITATIVE_BODY: ReadonlySet<SourceKind> = new Set([
  'qiita',
  'github_release',
  'changelog',
]);

/**
 * 抽出結果が本文らしいか。ナビゲーションやフッターの塊は句点をほとんど含まないので、
 * 文の区切りの密度で弾く。
 */
function looksLikeProse(text: string): boolean {
  if (text.length < 300) return false;
  const sentences = (text.match(/[。．.!?！？]\s/gu) ?? []).length + (text.match(/[。！？]/gu) ?? []).length;
  return sentences >= Math.max(3, text.length / 800);
}

/**
 * Readability が抜いた本文。
 *
 * contentHtml（本文だけの HTML）を一緒に返すのは、本文中の画像を拾うため。
 * ページ全体の HTML から画像を拾うと、サイドバーの関連記事のサムネイルや
 * フッターのバナーが混ざる——それは「記事の中で使われている画像」ではない。
 */
interface Article {
  text: string;
  contentHtml: string;
}

/**
 * HTML から本文を抽出する。本文らしくなければ空を返す（誤った本文より無い方がまし）。
 *
 * 本文らしくないときは contentHtml も返さない。抽出した範囲が記事の外なら、
 * そこにある画像も記事の画像ではないため。
 */
function extractArticle(html: string, url: string): Article {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent?.trim().replace(/\n{3,}/g, '\n\n') ?? '';
    if (!looksLikeProse(text)) return { text: '', contentHtml: '' };
    return { text, contentHtml: article?.content ?? '' };
  } catch {
    // 抽出できなければ本文なしとして扱う
    return { text: '', contentHtml: '' };
  }
}

/** 1 件ぶんに足せたもの。取れなかった項目は空のまま */
interface Enrichment {
  body?: string;
  imageUrl?: string;
  bodyImages: BodyImage[];
}

/**
 * 1 件ぶんの本文・サムネイル・本文中の画像を、記事ページの取得 1 回で揃える。
 *
 * 本文が既に手元にある記事でも記事ページを取りに行く。画像だけはまだ無いからで、
 * 収集時点の API 本文は Markdown を素のテキストに落としたもの——画像の URL は
 * その時点で消えている。取得は 1 回に集約して、同じページを二度取らないようにしている。
 */
async function enrichOne(item: RawItem, needBody: boolean): Promise<Enrichment> {
  const out: Enrichment = { bodyImages: [] };

  /*
   * 本文を API から取れるソースは、そちらを先に使う（ページ HTML から抜くと UI 部品を拾う）。
   * Zenn は本文の HTML がそのまま返るので、本文中の画像もここで拾える。
   * GitHub リポジトリは README の Markdown なので画像は拾わず、下のページ HTML 側に任せる。
   */
  if (needBody && item.source === 'zenn') {
    const html = await safe(`zenn(${item.url})`, () => fetchZennBodyHtml(item.url), '');
    if (html) {
      out.body = stripHtml(html);
      out.bodyImages = pickBodyImages(html, item.url);
    }
  } else if (needBody && item.source === 'github_repo') {
    out.body = await safe(`readme(${item.url})`, () => fetchGithubReadme(item.url), '');
  }

  const page = await safe(
    `page(${item.url})`,
    () =>
      fetchText(item.url, {
        timeoutMs: 20_000,
        retries: 1,
        headers: { accept: 'text/html,application/xhtml+xml' },
      }),
    '',
  );
  if (page) {
    const article = extractArticle(page, item.url);
    if (needBody && !out.body) out.body = article.text;
    if (out.bodyImages.length === 0 && article.contentHtml) {
      out.bodyImages = pickBodyImages(article.contentHtml, item.url);
    }
    out.imageUrl = await resolveImage(item, page);
  }

  out.bodyImages = await verifyBodyImages(out.bodyImages, out.imageUrl);
  return out;
}

/**
 * 深掘り対象候補に足す付加情報。
 *
 * 本文中の画像を items に載せずに別で返しているのは、**候補を保存しないため**。
 * 実際に引用した 1〜2 枚は解説側（DeepDive.figures）に残るので、候補まで JSON に
 * 書くと使わなかった URL が毎日ぶん git 履歴に積もる。
 */
export interface Enriched {
  items: RawItem[];
  /** 記事 id → 本文中の画像の候補 */
  bodyImages: Map<string, BodyImage[]>;
}

/**
 * 深掘り対象候補の本文・サムネイル・本文中の画像を取得する。
 *
 * 本文の取得は、収集時点で本文が取れているソースをスキップする。
 * サムネイルと本文中の画像は全件を対象にする——本文が既にあっても画像はまだ無いため。
 * ただし og:image が常に自動生成カードのソース（Qiita など）は image.ts 側で最初に外れる。
 */
export async function enrichTopItems(items: RawItem[], charLimit: number): Promise<Enriched> {
  const needBody = new Set(
    items
      .filter((i) => !AUTHORITATIVE_BODY.has(i.source) && (!i.body || i.body.length < 400))
      .map((i) => i.id),
  );

  const got = new Map<string, Enrichment>();
  await mapLimit(items, 5, async (item) => {
    got.set(item.id, await enrichOne(item, needBody.has(item.id)));
  });

  /* 短すぎる抽出結果は本文として使わない（ページの断片を本文と見なさない） */
  const fetchedBody = (id: string): string | undefined => {
    const body = got.get(id)?.body;
    return body && body.length >= 200 ? body : undefined;
  };

  if (needBody.size > 0) {
    const ok = [...needBody].filter((id) => fetchedBody(id)).length;
    log.info(`  本文取得: ${ok}/${needBody.size} 件`);
  }
  const thumbs = [...got.values()].filter((g) => g.imageUrl).length;
  log.info(`  サムネイル取得: ${thumbs}/${items.length} 件`);
  const figures = [...got.values()].filter((g) => g.bodyImages.length > 0);
  const sheets = figures.reduce((n, g) => n + g.bodyImages.length, 0);
  log.info(`  記事内の画像: ${sheets} 枚（${figures.length}/${items.length} 記事）`);

  return {
    items: items.map((item) => {
      const body = fetchedBody(item.id) ?? item.body;
      const imageUrl = got.get(item.id)?.imageUrl;
      return {
        ...item,
        ...(imageUrl ? { imageUrl } : {}),
        ...(body
          ? {
              body: truncate(body, charLimit),
              snippet: item.snippet || truncate(body.replace(/\s+/g, ' ').trim(), 400),
            }
          : {}),
      };
    }),
    bodyImages: new Map([...got].map(([id, g]) => [id, g.bodyImages])),
  };
}

/** はてなブックマーク数を全アイテムに付与する（人気度シグナルの底上げ） */
export async function enrichHatenaCounts(items: RawItem[]): Promise<RawItem[]> {
  const urls = items.map((i) => i.url);
  const counts = await safe(
    'hatena-counts',
    () => fetchHatenaCounts(urls),
    new Map<string, number>(),
  );
  if (counts.size === 0) return items;

  let hits = 0;
  const out = items.map((item) => {
    const count = counts.get(item.url);
    if (!count) return item;
    hits++;
    return { ...item, metrics: { ...item.metrics, hatena: count } };
  });
  log.info(`  はてブ数付与: ${hits} 件`);
  return out;
}
