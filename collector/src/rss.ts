import { XMLParser } from 'fast-xml-parser';
import { fetchText, stripHtml } from './util.js';

export interface FeedEntry {
  title: string;
  link: string;
  publishedAt: Date | null;
  summary: string;
  content: string;
  author?: string;
  tags: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  /*
   * 数値文字参照（&#x306F; / &#12354;）を解くのはこの指定。
   *
   * processEntities だけでは &amp; &lt; &gt; &quot; しか解かない。はてなブックマークの
   * RSS は日本語を全部 &#x306F; 形式で書いてくるので（実測で 1 フィードに 16,253 箇所）、
   * これが無いとタイトルとタグが実体参照のまま画面に出る。
   */
  htmlEntities: true,
  removeNSPrefix: false,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text'] ?? '');
  }
  return '';
}

function pickLink(node: Record<string, unknown>): string {
  // Atom: <link rel="alternate" href="..."/>
  const links = asArray(node.link as unknown);
  for (const l of links) {
    if (typeof l === 'string' && l) return l;
    if (l && typeof l === 'object') {
      const rec = l as Record<string, unknown>;
      const rel = String(rec['@_rel'] ?? 'alternate');
      const href = rec['@_href'];
      if (href && (rel === 'alternate' || rel === '')) return String(href);
    }
  }
  for (const l of links) {
    if (l && typeof l === 'object') {
      const href = (l as Record<string, unknown>)['@_href'];
      if (href) return String(href);
    }
  }
  // RSS 1.0 (RDF)
  const about = node['@_rdf:about'] ?? node['@_about'];
  if (about) return String(about);
  const guid = text(node.guid);
  if (guid.startsWith('http')) return guid;
  return '';
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickDate(node: Record<string, unknown>): Date | null {
  const candidates = [
    node.published,
    node.updated,
    node.pubDate,
    node['dc:date'],
    node.date,
    node['@_dc:date'],
  ];
  for (const c of candidates) {
    const d = parseDate(text(c));
    if (d) return d;
  }
  return null;
}

function pickTags(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const c of asArray(node.category as unknown)) {
    if (typeof c === 'string') out.push(c);
    else if (c && typeof c === 'object') {
      const rec = c as Record<string, unknown>;
      const v = rec['@_term'] ?? rec['#text'];
      if (v) out.push(String(v));
    }
  }
  for (const s of asArray(node['dc:subject'] as unknown)) {
    const v = text(s);
    if (v) out.push(v);
  }
  for (const s of asArray(node['hatena:subject'] as unknown)) {
    const v = text(s);
    if (v) out.push(v);
  }
  return [...new Set(out.map((t) => t.trim()).filter(Boolean))].slice(0, 12);
}

function pickAuthor(node: Record<string, unknown>): string | undefined {
  const a = node.author ?? node['dc:creator'] ?? node.creator;
  if (!a) return undefined;
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    const rec = a as Record<string, unknown>;
    const name = rec.name ?? rec['#text'];
    if (name) return String(name);
  }
  return undefined;
}

function toEntry(node: Record<string, unknown>): FeedEntry | null {
  const title = stripHtml(text(node.title)).trim();
  const link = pickLink(node);
  if (!title || !link) return null;

  const contentRaw =
    text(node['content:encoded']) ||
    text(node.content) ||
    text(node.description) ||
    text(node.summary);
  const summaryRaw = text(node.summary) || text(node.description) || contentRaw;

  return {
    title,
    link,
    publishedAt: pickDate(node),
    summary: stripHtml(summaryRaw),
    content: stripHtml(contentRaw),
    author: pickAuthor(node),
    tags: pickTags(node),
  };
}

/** RSS 1.0 / RSS 2.0 / Atom を吸収して共通の形に落とす */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, unknown>;

  type Node = Record<string, unknown>;

  const rdf = doc['rdf:RDF'] as Node | undefined;
  if (rdf) {
    return asArray<Node>(rdf.item as Node | Node[] | undefined)
      .map(toEntry)
      .filter((e): e is FeedEntry => e !== null);
  }

  const rss = doc.rss as Node | undefined;
  if (rss) {
    const channel = rss.channel as Node | undefined;
    return asArray<Node>(channel?.item as Node | Node[] | undefined)
      .map(toEntry)
      .filter((e): e is FeedEntry => e !== null);
  }

  const feed = doc.feed as Node | undefined;
  if (feed) {
    return asArray<Node>(feed.entry as Node | Node[] | undefined)
      .map(toEntry)
      .filter((e): e is FeedEntry => e !== null);
  }

  return [];
}

export async function fetchFeed(url: string): Promise<FeedEntry[]> {
  const xml = await fetchText(url, {
    timeoutMs: 20_000,
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  return parseFeed(xml);
}
