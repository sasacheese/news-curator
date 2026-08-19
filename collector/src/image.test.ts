import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGeneratedCard, pickOgImage, readImageSize } from './image.js';

/* ------------------------------------------------------------------ *
 * pickOgImage
 * ------------------------------------------------------------------ */

test('属性の順番がどちらでも content を取れる', () => {
  const propertyFirst = '<head><meta property="og:image" content="https://e.test/a.png"></head>';
  const contentFirst = '<head><meta content="https://e.test/b.png" property="og:image" /></head>';
  assert.equal(pickOgImage(propertyFirst, 'https://e.test/'), 'https://e.test/a.png');
  assert.equal(pickOgImage(contentFirst, 'https://e.test/'), 'https://e.test/b.png');
});

test('og:image が無ければ twitter:image を使う', () => {
  const html = '<head><meta name="twitter:image" content="https://e.test/t.png"></head>';
  assert.equal(pickOgImage(html, 'https://e.test/'), 'https://e.test/t.png');
});

test('相対パスは記事の URL を基準に絶対化する', () => {
  const html = '<head><meta property="og:image" content="/img/hero.jpg"></head>';
  assert.equal(pickOgImage(html, 'https://e.test/posts/1'), 'https://e.test/img/hero.jpg');
});

test('実体参照を解く（クエリ付きの CDN URL が壊れないように）', () => {
  const html = '<head><meta property="og:image" content="https://e.test/a.png?w=1200&amp;h=630"></head>';
  assert.equal(pickOgImage(html, 'https://e.test/'), 'https://e.test/a.png?w=1200&h=630');
});

test('head の外の meta は見ない', () => {
  const html =
    '<head><title>x</title></head><body><meta property="og:image" content="https://e.test/x.png"></body>';
  assert.equal(pickOgImage(html, 'https://e.test/'), '');
});

test('http / https 以外のスキームは弾く', () => {
  const html = '<head><meta property="og:image" content="javascript:alert(1)"></head>';
  assert.equal(pickOgImage(html, 'https://e.test/'), '');
});

/* ------------------------------------------------------------------ *
 * isGeneratedCard —— 実データ（直近 10 日・58 件）から採った URL で確かめる
 * ------------------------------------------------------------------ */

test('タイトルを描いた自動生成カードを落とす', () => {
  // Qiita: 記事タイトルを imgix で焼き込んだカード
  assert.equal(
    isGeneratedCard(
      'https://qiita-user-contents.imgix.net/https%3A%2F%2Fcdn.qiita.com%2Fassets%2Fpublic%2Farticle-ogp-background.png?txt=Cursor',
    ),
    true,
  );
  // GitHub: リポジトリ名・説明・スター数のカード
  assert.equal(
    isGeneratedCard('https://opengraph.githubassets.com/7ed1909b/BOMWiki/partmode'),
    true,
  );
  // Zenn: Cloudinary の文字合成でタイトルを焼き込んだカード
  assert.equal(
    isGeneratedCard(
      'https://res.cloudinary.com/zenn/image/upload/s--BQ6yKX4L--/c_fit%2Cg_north_west%2Cl_text:notosansjp-medium.otf_55:Claude/og.png',
    ),
    true,
  );
});

test('記事ごとに変わらない汎用素材を落とす', () => {
  const generic = [
    'https://storage.googleapis.com/assets/images/Go_Logo_-_Blue.fill-1200x600.png',
    'https://dka575ofm4ao0.cloudfront.net/pages-twitter_logos/original/36420/GitHub-Mark.png',
    'https://github.blog/wp-content/uploads/2025/08/wallpaper-generic-.png',
    // 画像 CDN 越しに配られるので、元の URL がパスに percent-encode で埋まっている
    'https://substackcdn.com/image/fetch/$s_!v6i6!,f_auto/https%3A%2F%2Frickmanelius.substack.com%2Ftwitter%2Fsubscribe-card.jpg%3Fv%3D-1034328908',
    // 静的サイトジェネレーターが記事ごとに作るカード（中身はタイトルと副題の文字）
    'https://allen.bargi.org/notes/working-with-ai-feels-like-leadership/social-card.png',
  ];
  for (const url of generic) assert.equal(isGeneratedCard(url), true, url);
});

test('書き手が置いた画像は残す', () => {
  const real = [
    'https://i.gzn.jp/img/2026/08/10/ai-ram-price/00.png',
    'https://pc.watch.impress.co.jp/img/pcw/list/2132/712/1.jpg',
    'https://www.itmedia.co.jp/news/article/ogp/2608/09/2000000463/10002212/2048',
    // リポジトリ所有者が設定したソーシャルプレビュー（自動生成カードとは別物）
    'https://repository-images.githubusercontent.com/1333065091/0150c8e6-11ef-4ecb.png',
    // Zenn でも書き手が指定した画像は文字合成を含まない
    'https://res.cloudinary.com/zenn/image/upload/v1/uploads/hero.png',
    // 編集部が用意したイラスト。ハッシュだけの名前なので URL からは中身を判断しない
    'https://cdn.shopify.com/b/shopify-brochure2-assets/d5a289aad251536cebddff8378b429f0.png',
  ];
  for (const url of real) assert.equal(isGeneratedCard(url), false, url);
});

test('URL として壊れているものは落とす', () => {
  assert.equal(isGeneratedCard('not a url'), true);
});

/* ------------------------------------------------------------------ *
 * readImageSize
 * ------------------------------------------------------------------ */

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(b.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return b;
}

/** SOI + APP0（読み飛ばす対象）+ SOF0 の最小構成 */
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  const view = new DataView(b.buffer);
  b.set([0xff, 0xd8], 0);
  b.set([0xff, 0xe0], 2);
  view.setUint16(4, 8); // APP0 のセグメント長
  b.set([0xff, 0xc0], 12);
  view.setUint16(14, 17); // SOF0 のセグメント長
  b[16] = 8; // 精度
  view.setUint16(17, height);
  view.setUint16(19, width);
  return b;
}

test('PNG / GIF / JPEG の寸法を読む', () => {
  assert.deepEqual(readImageSize(png(1200, 630)), { width: 1200, height: 630 });
  assert.deepEqual(readImageSize(gif(320, 240)), { width: 320, height: 240 });
  assert.deepEqual(readImageSize(jpeg(1024, 512)), { width: 1024, height: 512 });
});

test('判別できない中身は null（画面側で落とさず通すため）', () => {
  assert.equal(readImageSize(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null);
  assert.equal(readImageSize(new Uint8Array(0)), null);
});
