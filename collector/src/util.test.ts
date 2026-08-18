import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanUrl,
  decodeEntities,
  isHttpUrl,
  jstDateString,
  normalizeUrl,
  resolveWindow,
  stripHtml,
  titleKey,
} from './util.js';

/*
 * 時刻まわりは JST 固定・07:00 区切りという前提が全体に効いているので、
 * ここがずれると「その日のダイジェスト」が丸ごと 1 日ぶんずれる。
 * 実行環境の TZ に依存しないことも同時に確認している（CI は UTC、手元は JST）。
 */

describe('resolveWindow', () => {
  it('前日 07:00 JST 〜 当日 07:00 JST の 24 時間を返す', () => {
    const { start, end } = resolveWindow(new Date('2026-08-02T12:00:00Z'), '2026-08-02');
    // 07:00 JST = 22:00 UTC 前日
    assert.equal(end.toISOString(), '2026-08-01T22:00:00.000Z');
    assert.equal(start.toISOString(), '2026-07-31T22:00:00.000Z');
    assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  });

  it('07:00 JST より前に走ったら前日ぶんを対象にする', () => {
    // 2026-08-02 06:00 JST = 2026-08-01 21:00 UTC
    const { date } = resolveWindow(new Date('2026-08-01T21:00:00Z'));
    assert.equal(date, '2026-08-01');
  });

  it('07:00 JST 以降なら当日ぶん', () => {
    // 2026-08-02 07:30 JST = 2026-08-01 22:30 UTC
    const { date } = resolveWindow(new Date('2026-08-01T22:30:00Z'));
    assert.equal(date, '2026-08-02');
  });

  it('cron が遅延して 08:00 JST に走ってもウィンドウは動かない', () => {
    // GitHub Actions の cron は十数分遅れることがある
    const onTime = resolveWindow(new Date('2026-08-01T22:00:00Z'));
    const late = resolveWindow(new Date('2026-08-01T23:00:00Z'));
    assert.equal(onTime.date, late.date);
    assert.equal(onTime.start.toISOString(), late.start.toISOString());
  });

  it('日付を明示したらその日の 07:00 JST が終端', () => {
    const { date, end } = resolveWindow(new Date('2026-01-01T00:00:00Z'), '2026-03-15');
    assert.equal(date, '2026-03-15');
    assert.equal(end.toISOString(), '2026-03-14T22:00:00.000Z');
  });

  it('月初・年初をまたいでも壊れない', () => {
    const { start, end } = resolveWindow(new Date('2026-01-01T12:00:00Z'), '2026-01-01');
    assert.equal(end.toISOString(), '2025-12-31T22:00:00.000Z');
    assert.equal(start.toISOString(), '2025-12-30T22:00:00.000Z');
  });
});

describe('jstDateString', () => {
  it('UTC 深夜は JST では翌日', () => {
    // 2026-08-01 23:00 UTC = 2026-08-02 08:00 JST
    assert.equal(jstDateString(new Date('2026-08-01T23:00:00Z')), '2026-08-02');
  });

  it('UTC 昼は JST でも同日', () => {
    assert.equal(jstDateString(new Date('2026-08-01T03:00:00Z')), '2026-08-01');
  });
});

/*
 * cleanUrl は保存・表示に使う URL、normalizeUrl は突き合わせ用のキー。
 * ここを混ぜると `www.` を落とした URL が画面に出て、ITmedia や日経のように
 * apex ドメインがトップページへ飛ばすサイトの記事に辿り着けなくなる。
 */
describe('cleanUrl', () => {
  it('トラッキングパラメータとフラグメントを落とす', () => {
    assert.equal(
      cleanUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7#top'),
      'https://example.com/a?id=7',
    );
  });

  it('www と末尾スラッシュは配信元の形のまま残す', () => {
    assert.equal(
      cleanUrl('https://www.itmedia.co.jp/news/article/2608/17/2000000563/'),
      'https://www.itmedia.co.jp/news/article/2608/17/2000000563/',
    );
  });

  it('URL として壊れていれば原文をそのまま返す', () => {
    assert.equal(cleanUrl('not a url'), 'not a url');
  });
});

describe('normalizeUrl', () => {
  it('トラッキングパラメータを落とす', () => {
    assert.equal(
      normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7'),
      'https://example.com/a?id=7',
    );
  });

  it('www・末尾スラッシュ・フラグメントを揃える', () => {
    assert.equal(normalizeUrl('https://WWW.Example.com/a/#section'), 'https://example.com/a');
  });

  it('意味のあるクエリは残す', () => {
    assert.equal(normalizeUrl('https://example.com/s?q=react'), 'https://example.com/s?q=react');
  });

  it('URL として壊れていれば原文をそのまま返す', () => {
    assert.equal(normalizeUrl('not a url'), 'not a url');
  });

  it('www の有無だけが違う URL は同じキーになる', () => {
    assert.equal(
      normalizeUrl('https://www.itmedia.co.jp/news/article/2608/17/2000000563/'),
      normalizeUrl('https://itmedia.co.jp/news/article/2608/17/2000000563'),
    );
  });
});

describe('isHttpUrl', () => {
  it('http/https だけ通す', () => {
    assert.equal(isHttpUrl('https://example.com'), true);
    assert.equal(isHttpUrl('http://example.com'), true);
    assert.equal(isHttpUrl('javascript:alert(1)'), false);
    assert.equal(isHttpUrl('data:text/html,<script>'), false);
    assert.equal(isHttpUrl('file:///etc/passwd'), false);
    assert.equal(isHttpUrl(''), false);
  });
});

describe('decodeEntities', () => {
  it('数値文字参照（16進）をほどく', () => {
    // はてなブックマークの RSS は日本語を全部この形で書いてくる
    assert.equal(decodeEntities('&#x306F;&#x3066;&#x306A;'), 'はてな');
  });

  it('数値文字参照（10進）をほどく', () => {
    assert.equal(decodeEntities('&#12354;&#12356;'), 'あい');
  });

  it('BMP 外（絵文字）も1文字として扱う', () => {
    // String.fromCharCode ではなく fromCodePoint でないと壊れる
    assert.equal(decodeEntities('&#x1F431;'), '🐱');
  });

  it('名前付きもほどく', () => {
    assert.equal(decodeEntities('a&lt;b&gt;c&quot;d&apos;e&nbsp;f'), 'a<b>c"d\'e f');
  });

  it('&amp; は最後にほどく（二重解除しない）', () => {
    // 先に & を戻すと「&amp;lt;」が「<」まで戻ってしまう
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('A&amp;B'), 'A&B');
  });

  it('二重エスケープされた & だけは 1 文字まで戻す', () => {
    // 元 HTML が二重エスケープしていた製品名。1 段だけだと画面に「&amp;」が出る
    assert.equal(decodeEntities('O&amp;amp;O ShutUp 10'), 'O&O ShutUp 10');
    assert.equal(decodeEntities('Apple Intelligence &amp;amp; Siri'), 'Apple Intelligence & Siri');
    // 「&lt;」を書きたかったケースは巻き込まない
    assert.equal(decodeEntities('&amp;lt;div&amp;gt;'), '&lt;div&gt;');
  });

  it('壊れた参照は落とさずそのまま残す', () => {
    assert.equal(decodeEntities('&nope; &# &#x;'), '&nope; &# &#x;');
  });

  it('サロゲート単体・範囲外は捨てる', () => {
    assert.equal(decodeEntities('&#xD800;'), '');
    assert.equal(decodeEntities('&#x110000;'), '');
  });
});

describe('stripHtml', () => {
  it('タグを落として実体参照をほどく', () => {
    assert.equal(stripHtml('<p>&#x3053;&#x3093;&#x306B;&#x3061;&#x306F;</p>'), 'こんにちは');
  });

  it('文字列として書かれたタグはタグとして除去しない', () => {
    // 先に実体参照をほどくと <script> がタグ扱いされて中身が消える
    assert.equal(stripHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<script>alert(1)</script>');
  });

  it('script の中身は落とす', () => {
    assert.equal(stripHtml('a<script>bad()</script>b'), 'a b');
  });
});

describe('titleKey', () => {
  it('空白と記号を無視する', () => {
    assert.equal(titleKey('React 19 の新機能！'), titleKey('React19の新機能'));
  });

  it('別の記事は別のキーになる', () => {
    assert.notEqual(titleKey('React 19 の新機能'), titleKey('Vue 4 の新機能'));
  });
});
