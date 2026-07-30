import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { fetchGithubReadme, fetchHatenaCounts, fetchZennBody } from './sources.js';
import type { RawItem, SourceKind } from './types.js';
import { fetchText, log, mapLimit, safe, truncate } from './util.js';

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

/** HTML から本文を抽出する。本文らしくなければ空を返す（誤った本文より無い方がまし）。 */
function extractArticle(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent?.trim().replace(/\n{3,}/g, '\n\n');
    if (text && looksLikeProse(text)) return text;
  } catch {
    // 抽出できなければ本文なしとして扱う
  }
  return '';
}

async function fetchBody(item: RawItem): Promise<string> {
  if (item.source === 'zenn') return await fetchZennBody(item.url);
  if (item.source === 'github_repo') return await fetchGithubReadme(item.url);

  const html = await fetchText(item.url, {
    timeoutMs: 20_000,
    retries: 1,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  return extractArticle(html, item.url);
}

/**
 * 深掘り対象候補の本文を取得する。
 * 収集時点で本文が取れているソースはスキップする。
 */
export async function enrichBodies(items: RawItem[], charLimit: number): Promise<RawItem[]> {
  const need = items.filter(
    (i) => !AUTHORITATIVE_BODY.has(i.source) && (!i.body || i.body.length < 400),
  );
  if (need.length === 0) return items;

  const bodies = new Map<string, string>();
  await mapLimit(need, 5, async (item) => {
    const body = await safe(`body(${item.url})`, () => fetchBody(item), '');
    if (body.length >= 200) bodies.set(item.id, body);
  });

  log.info(`  本文取得: ${bodies.size}/${need.length} 件`);

  return items.map((item) => {
    const body = bodies.get(item.id) ?? item.body;
    if (!body) return item;
    return {
      ...item,
      body: truncate(body, charLimit),
      snippet: item.snippet || truncate(body.replace(/\s+/g, ' ').trim(), 400),
    };
  });
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
