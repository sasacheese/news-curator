import type { RawItem, SourceKind } from './types.js';
import { fetchText, fetchWithRetry, log, safe } from './util.js';

/**
 * ベスト記事のサムネイル画像を決める。
 *
 * 方針は「タイトルを画像にしただけのカードは載せない」の一点。実測（10日・58件）では
 * og:image の 7 割が Qiita・Zenn・GitHub の自動生成カードで、描かれているのは記事タイトルと
 * リポジトリ名——どちらもカードの見出しにすでに出ている文字だった。それを画像として
 * もう一度出すと、1 枚ぶんの面積を使って情報が 1 文字も増えない。残すのは書き手・編集部が
 * 自分で置いた画像（記事写真、スクリーンショット、図）だけにする。
 * 結果として画像が付く日は 6 件中 1 件前後で、**付かないほうが既定**になる。
 *
 * 画像はリポジトリに取り込まず、配信元を直接参照する（ホットリンク）。取り込むと
 * public リポジトリで他人の画像を再配布することになり、毎日ぶんが git 履歴に永久に残る。
 * 代わりに配信元が消せば画像も消えるので、画面側は落ちたときに枠ごと畳む。
 */

/**
 * og:image が常に自動生成カードのソース。HTML を取りに行くだけ無駄なので最初に外す。
 *
 * - qiita: 記事に画像があっても og:image はタイトル合成画像で固定（実測 27/27 件）
 * - github_release / changelog: リポジトリ名と説明を描いた GitHub のカード
 */
const NO_REAL_OG: ReadonlySet<SourceKind> = new Set(['qiita', 'github_release', 'changelog']);

/** 中身が文字だけと分かっている自動生成カードの配信元 */
const GENERATED_CARD_HOSTS: readonly string[] = [
  'qiita-user-contents.imgix.net',
  'opengraph.githubassets.com',
];

/**
 * ファイル名で「読まなくていい画像」と分かるもの。2 種類ある。
 *
 * - 記事ごとに変わらない汎用素材（サイトのロゴ、既定の壁紙、購読カード）
 * - 静的サイトジェネレーターが記事ごとに作る共有用カード。実物を見たところ
 *   `social-card.png` は記事タイトルと副題を大きく描いただけで、Qiita のカードと中身が同じだった
 */
const GENERIC_NAME =
  /(^|[/_-])(logos?|wallpaper|generic|default|placeholder|subscribe-card|social-card|social-image|og-image|opengraph|share-card|twitter-card)([/_.-]|$)/i;

/** これより小さい画像はアイコンやロゴとみなす */
const MIN_WIDTH = 400;
const MIN_HEIGHT = 200;

/** 画像の先頭だけ読めば寸法は分かる。全部落とさないための上限 */
const HEAD_BYTES = 64 * 1024;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (m) => ENTITIES[m] ?? m);
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m?.[1] ?? '';
}

/**
 * head の meta から画像 URL を取り出す。
 *
 * 属性の順番は配信元によってばらばらで（`property` が先の Qiita、`content` が先の GitHub）、
 * 正規表現 1 本で両方を拾おうとすると読めなくなる。meta タグを列挙してから属性を引く。
 */
export function pickOgImage(html: string, baseUrl: string): string {
  // 本文にも meta 風の文字列は出るので head までに限る。閉じタグが無いページは頭 200KB
  const headEnd = html.search(/<\/head>/i);
  const head = html.slice(0, headEnd >= 0 ? headEnd : 200_000);
  const found = new Map<string, string>();

  for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (!key) continue;
    const content = decodeEntities(attr(tag, 'content')).trim();
    if (content && !found.has(key)) found.set(key, content);
  }

  // og:image を主に見る。twitter:image は og が無いサイトの控え
  const raw = found.get('og:image') || found.get('twitter:image') || found.get('twitter:image:src');
  if (!raw) return '';

  try {
    const url = new URL(raw, baseUrl);
    // 画面で href に入れる前に web 側でも検証するが、保存する時点で弾いておく
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** タイトルを描いただけのカードか、記事と無関係の汎用素材か */
export function isGeneratedCard(imageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return true;
  }

  if (GENERATED_CARD_HOSTS.includes(url.host)) return true;

  /*
   * Zenn は書き手が指定した画像も同じ CDN から出るので、ホストでは切れない。
   * 自動生成のほうは Cloudinary の文字合成（l_text:）でタイトルを焼き込んでいるので、
   * その指示があるかどうかで見分ける。
   */
  if (url.host.endsWith('cloudinary.com') && url.pathname.includes('l_text:')) return true;

  /*
   * 画像 CDN を経由すると、元の URL がパスの中に percent-encode で埋まる
   * （Substack が Cloudinary 越しに配る購読カードがこれ）。解いてから名前を見る。
   */
  let path = url.pathname + url.search;
  try {
    path = decodeURIComponent(path);
  } catch {
    // 不正なエスケープを含む URL は素のまま判定する
  }
  return GENERIC_NAME.test(path);
}

/**
 * 画像の寸法をヘッダーから読む。判別できない形式は null。
 *
 * URL では見分けられない汎用素材——サイトのロゴを og:image にしている配信元——を
 * 落とすために使う。実データでは 120px のロゴがそれで、URL からは記事画像と区別できなかった。
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.subarray(start, start + len));

  // PNG: 8 バイトの署名 + IHDR チャンクに幅と高さが固定位置で入る
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: ヘッダー直後にリトルエンディアンで幅と高さ
  if (bytes.length >= 10 && ascii(0, 3) === 'GIF') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: 可逆（VP8L）はビット詰めなので読まない。非可逆と拡張だけ拾う
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') {
      const read24 = (o: number) =>
        (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8) | ((bytes[o + 2] ?? 0) << 16);
      return { width: read24(24) + 1, height: read24(27) + 1 };
    }
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    return null;
  }

  // JPEG: 寸法はセグメントの中なので、SOF が出るまでマーカーを辿る
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1] ?? 0;
      // スタンドアロンのマーカー（パディング・RSTn・SOI/EOI）は長さを持たない
      if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      i += 2 + view.getUint16(i + 2);
    }
  }

  return null;
}

/**
 * その URL が画面に出せる画像か、実際に取って確かめる。
 *
 * ここで落としておくのは、生成の時点なら黙って画像なしにできるから。読者の画面で
 * 404 や hotlink 拒否に当たると、枠が空いたカードだけが残る。
 */
export async function verifyImage(url: string): Promise<boolean> {
  const res = await fetchWithRetry(url, {
    timeoutMs: 15_000,
    retries: 1,
    headers: { accept: 'image/*', range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!res.ok) return false;
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return false;

  const bytes = new Uint8Array(await res.arrayBuffer());
  const size = readImageSize(bytes);
  // 寸法を読めない形式（SVG、可逆 WebP）は、ここまで残っている時点で通す
  if (!size) return true;
  return size.width >= MIN_WIDTH && size.height >= MIN_HEIGHT;
}

/**
 * 1 件ぶんのサムネイルを決める。
 *
 * html は本文取得で既に取れていれば渡す（取り直さないため）。
 * Zenn と GitHub リポジトリは本文を API から取っていて HTML が手元に無いので、
 * ここで取りに行く——どちらも書き手が画像を指定できる（実測でリポジトリ側に 2 件あった）。
 */
export async function resolveImage(item: RawItem, html?: string): Promise<string | undefined> {
  if (NO_REAL_OG.has(item.source)) return undefined;

  const page =
    html ??
    (await safe(
      `og(${item.url})`,
      () =>
        fetchText(item.url, {
          timeoutMs: 20_000,
          retries: 1,
          headers: { accept: 'text/html,application/xhtml+xml' },
        }),
      '',
    ));
  if (!page) return undefined;

  const candidate = pickOgImage(page, item.url);
  if (!candidate || isGeneratedCard(candidate)) return undefined;

  const usable = await safe(`image(${candidate})`, () => verifyImage(candidate), false);
  if (!usable) return undefined;

  log.info(`  サムネイル: ${item.title.slice(0, 30)} ← ${new URL(candidate).host}`);
  return candidate;
}
