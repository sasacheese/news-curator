import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  imageIdentity,
  isDecorativeImage,
  isGeneratedCard,
  pickBodyImages,
  pickOgImage,
  readImageSize,
} from './image.js';

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

/* ------------------------------------------------------------------ *
 * isDecorativeImage —— 本文の画像は og:image と判定が別（同じホストに両方が来る）
 * ------------------------------------------------------------------ */

test('本文の装飾（バッジ・アバター・アイコン）を落とす', () => {
  const noise = [
    'https://img.shields.io/badge/build-passing-green.svg',
    'https://avatars.githubusercontent.com/u/12345?v=4',
    'https://secure.gravatar.com/avatar/abc',
    'https://example.test/assets/icon-check.png',
    'https://example.test/img/emoji/smile.png',
    'https://example.test/static/favicon.png',
  ];
  for (const url of noise) assert.equal(isDecorativeImage(url), true, url);
});

test('文字を焼き込んだ合成画像は本文でも落とす', () => {
  // Qiita のタイトルカード。imgix の txt= で文字を合成している
  assert.equal(
    isDecorativeImage(
      'https://qiita-user-contents.imgix.net/https%3A%2F%2Fcdn.qiita.com%2Fassets%2Fpublic%2Farticle-ogp-background.png?txt=Cursor',
    ),
    true,
  );
});

test('書き手がアップロードした本文の画像は残す（ホストで切らない）', () => {
  const real = [
    // Qiita の本文画像。タイトルカードと同じ imgix から出るのでホストでは切れない
    'https://qiita-user-contents.imgix.net/https%3A%2F%2Fqiita-image-store.s3.ap-northeast-1.amazonaws.com%2F0%2F123%2Fe1f2.png?ixlib=rb-4.0.0',
    'https://res.cloudinary.com/zenn/image/upload/v1/uploads/deadbeef/screenshot.png',
    'https://example.test/2026/08/build-time-graph.png',
  ];
  for (const url of real) assert.equal(isDecorativeImage(url), false, url);
});

/* ------------------------------------------------------------------ *
 * pickBodyImages
 * ------------------------------------------------------------------ */

test('alt と前後の本文を添えて本文の画像を拾う', () => {
  const html =
    '<p>計測してみると、ビルド時間は半分になった。</p>' +
    '<img src="/img/graph.png" alt="ビルド時間の推移">' +
    '<p>左が変更前、右が変更後である。</p>';
  const [first, ...rest] = pickBodyImages(html, 'https://e.test/posts/1');
  assert.equal(rest.length, 0);
  assert.equal(first?.url, 'https://e.test/img/graph.png');
  assert.equal(first?.alt, 'ビルド時間の推移');
  assert.match(first!.context, /ビルド時間は半分になった/);
  assert.match(first!.context, /左が変更前/);
});

test('figcaption があれば alt より優先する（書き手が付けた説明のほうが情報が多い）', () => {
  const html =
    '<figure><img src="https://e.test/a.png" alt="screenshot">' +
    '<figcaption>設定画面。既定が opus に変わっている</figcaption></figure>';
  assert.equal(pickBodyImages(html, 'https://e.test/')[0]?.alt, '設定画面。既定が opus に変わっている');
});

test('遅延読み込みはプレースホルダーではなく data-src を見る', () => {
  const html = '<img src="/lazy-placeholder.gif" data-src="https://e.test/real.png">';
  assert.equal(pickBodyImages(html, 'https://e.test/')[0]?.url, 'https://e.test/real.png');
});

test('装飾・小さすぎる画像・重複を落とす', () => {
  const html =
    '<img src="https://img.shields.io/badge/ci-ok-green.svg">' +
    '<img src="https://e.test/tiny.png" width="80" height="80">' +
    '<img src="data:image/png;base64,AAAA">' +
    '<img src="https://e.test/shot.png">' +
    '<img src="https://e.test/shot.png">' +
    // 同じ写真を CDN の変換だけ変えて貼り直したもの
    '<img src="https://cdn.test/image/fetch/w_400/https%3A%2F%2Fe.test%2Fshot.png">';
  assert.deepEqual(
    pickBodyImages(html, 'https://e.test/').map((i) => i.url),
    ['https://e.test/shot.png'],
  );
});

test('候補は上限で打ち切る（確認の通信を無駄にしない）', () => {
  const html = Array.from({ length: 12 }, (_, i) => `<img src="https://e.test/${i}.png">`).join('');
  assert.equal(pickBodyImages(html, 'https://e.test/').length, 6);
});

/* ------------------------------------------------------------------ *
 * imageIdentity
 * ------------------------------------------------------------------ */

test('CDN の変換指定が違うだけの同じ写真を同一と見る', () => {
  // 実データ: 同じ写真が og:image は w_1200,h_675、本文側は w_1456 で来た
  const og =
    'https://substackcdn.com/image/fetch/$s_!kfb6!,w_1200,h_675,c_fill/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1015_2560x1920.jpeg';
  const body =
    'https://substackcdn.com/image/fetch/$s_!kfb6!,w_1456,c_limit/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1015_2560x1920.jpeg';
  assert.equal(imageIdentity(og), imageIdentity(body));
});

test('別の画像は別と見る（クエリの違いは無視する）', () => {
  assert.notEqual(imageIdentity('https://e.test/a.png'), imageIdentity('https://e.test/b.png'));
  assert.equal(
    imageIdentity('https://e.test/a.png?w=100'),
    imageIdentity('https://e.test/a.png?w=800'),
  );
});

test('前後の本文に、切れたタグの属性値を混ぜない', () => {
  // 実データでは srcset の URL がそのまま「前後の本文」に出ていた
  const html =
    '<p>前の段落です。</p><img srcset="https://e.test/a-1x.png 1x, https://e.test/a-2x.png 2x" ' +
    'src="https://e.test/a.png"><p>後ろの段落です。</p><img src="https://e.test/b.png" alt="次">';
  const first = pickBodyImages(html, 'https://e.test/')[0]!;
  assert.match(first.context, /前の段落です/);
  assert.match(first.context, /後ろの段落です/);
  assert.doesNotMatch(first.context, /srcset|1x|a-2x/);
});
