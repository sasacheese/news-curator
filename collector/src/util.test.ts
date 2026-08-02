import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHttpUrl, jstDateString, normalizeUrl, resolveWindow, titleKey } from './util.js';

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

describe('titleKey', () => {
  it('空白と記号を無視する', () => {
    assert.equal(titleKey('React 19 の新機能！'), titleKey('React19の新機能'));
  });

  it('別の記事は別のキーになる', () => {
    assert.notEqual(titleKey('React 19 の新機能'), titleKey('Vue 4 の新機能'));
  });
});
