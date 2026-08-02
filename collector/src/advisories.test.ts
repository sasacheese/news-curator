import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { packageMatcher } from './advisories.js';

/*
 * 監視対象リポジトリ名からパッケージ名を当てる部分。
 *
 * ここが緩すぎると無関係な脆弱性で画面が埋まり、厳しすぎると
 * 「使っているのに気づけない」になる。実在の対応関係で固定する。
 */

const REPOS = [
  'facebook/react',
  'vitejs/vite',
  'microsoft/TypeScript',
  'colinhacks/zod',
  'TanStack/router',
  'honojs/hono',
];

describe('packageMatcher', () => {
  const matches = packageMatcher(REPOS, ['@tanstack/react-router']);

  it('リポジトリ名がそのままパッケージ名のものを拾う', () => {
    assert.equal(matches('react'), true);
    assert.equal(matches('vite'), true);
    assert.equal(matches('zod'), true);
    assert.equal(matches('hono'), true);
  });

  it('大文字小文字を無視する', () => {
    // microsoft/TypeScript のパッケージ名は typescript
    assert.equal(matches('typescript'), true);
    assert.equal(matches('TypeScript'), true);
  });

  it('スコープが監視対象の owner なら拾う', () => {
    // TanStack/router から owner の tanstack を覚えているので当たる
    assert.equal(matches('@tanstack/react-query'), true);
  });

  it('extraPackages で名前がずれるものを補える', () => {
    // TanStack/router の実体は @tanstack/react-router
    assert.equal(matches('@tanstack/react-router'), true);
  });

  it('無関係なパッケージは拾わない', () => {
    assert.equal(matches('apostrophe'), false);
    assert.equal(matches('lodash'), false);
    assert.equal(matches('@types/node'), false);
  });

  it('空文字や空白だけは拾わない', () => {
    assert.equal(matches(''), false);
    assert.equal(matches('   '), false);
  });

  it('部分一致では拾わない（名前が似ているだけの別物を巻き込まない）', () => {
    // react-dom は監視対象ではないので拾わない（react の部分一致で通してはいけない）
    assert.equal(matches('react-native-super-grid'), false);
    assert.equal(matches('vite-plugin-evil'), false);
  });

  it('監視対象が空なら何も拾わない', () => {
    const none = packageMatcher([], []);
    assert.equal(none('react'), false);
  });

  it('書式の壊れた repo 指定は無視する', () => {
    const m = packageMatcher(['not-a-repo', ''], []);
    assert.equal(m('not-a-repo'), false);
  });
});
