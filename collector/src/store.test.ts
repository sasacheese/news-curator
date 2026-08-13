import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toIndexEntries } from './store.js';
import type { Digest, KnowDeepDive, RankedItem, ReleaseItem, TopItem } from './types.js';

/*
 * 検索インデックスの作り方。
 *
 * ダイジェストは同じ記事を「ベスト」と「リリース情報」の別枠で見せることがある
 * （リリースはランキングせず全件出す仕様なので、これは意図した重複）。
 * 一方インデックスは 1 記事 1 行でなければならない。検索結果に同じ記事が
 * 二重に並ぶし、画面の key も (date, id) なので衝突する。
 * ここで固定したいのは「表示の重複はインデックスに漏らさない」という境界。
 */

function ranked(over: Partial<RankedItem> & { id: string }): RankedItem {
  return {
    source: 'rss',
    sourceLabel: 'Example News',
    title: `記事 ${over.id}`,
    url: `https://example.com/${over.id}`,
    publishedAt: '2026-08-11T00:00:00.000Z',
    tags: [],
    snippet: '',
    metrics: {},
    lang: 'ja',
    sourceWeight: 1,
    preScore: 0.3,
    buzz: false,
    popularityPercentile: 0.5,
    matchedTopics: [],
    score: 50,
    oneLiner: `${over.id} の要約`,
    reason: '関心に近い',
    keywords: [],
    category: 'AI/エージェント',
    lane: 'know',
    debate: null,
    readingMinutes: 3,
    payoff: 'aware',
    durability: 'durable',
    ...over,
  };
}

function deep(headline: string): KnowDeepDive {
  return {
    lane: 'know',
    headline,
    summary: '',
    prerequisites: [],
    visual: null,
    code: null,
    whyItMatters: '',
    relatedLinks: [],
    readingMinutes: 3,
    impact: [],
    timeline: [],
    checkNow: [],
    unknowns: [],
  };
}

function top(over: Partial<RankedItem> & { id: string }, rank = 1): TopItem {
  return { ...ranked(over), rank, deep: deep(`${over.id} の見出し`) };
}

function release(over: Partial<ReleaseItem> & { id: string }): ReleaseItem {
  return {
    product: 'Example',
    what: null,
    version: null,
    kind: 'patch',
    impact: 'chore',
    unlock: null,
    change: null,
    scope: [],
    summary: 'リリースの中身',
    title: `リリース ${over.id}`,
    url: `https://example.com/${over.id}`,
    sourceLabel: 'GitHub Releases',
    publishedAt: '2026-08-11T00:00:00.000Z',
    alsoReleased: [],
    ...over,
  };
}

function digest(over: Partial<Digest>): Digest {
  return {
    date: '2026-08-11',
    generatedAt: '2026-08-11T00:00:00.000Z',
    window: { start: '2026-08-10T00:00:00.000Z', end: '2026-08-11T00:00:00.000Z' },
    summary: [],
    outlook: null,
    top: [],
    releases: [],
    others: [],
    stats: {
      collected: 0,
      afterDedupe: 0,
      afterPreScore: 0,
      ranked: 0,
      bySource: {},
      byLane: {},
      estimatedReadMinutes: 0,
    },
    ...over,
  } as Digest;
}

describe('toIndexEntries', () => {
  it('(date, id) が重複しない', () => {
    // 実データで起きていた形: 同じ記事が top とリリース情報の両方に載る日
    const entries = toIndexEntries(
      digest({
        top: [top({ id: 'dup' })],
        releases: [release({ id: 'dup' })],
        others: [ranked({ id: 'other' })],
      }),
    );

    const keys = entries.map((e) => `${e.date}-${e.id}`);
    assert.deepEqual([...new Set(keys)], keys, `重複した key: ${keys.join(', ')}`);
  });

  it('重複したときは top の側を残す', () => {
    // リリース側は score 0 / rank null / category 固定で、検索結果としては情報が薄い
    const [entry, ...rest] = toIndexEntries(
      digest({ top: [top({ id: 'dup', score: 62 }, 2)], releases: [release({ id: 'dup' })] }),
    );

    assert.deepEqual(rest, []);
    assert.ok(entry);
    assert.equal(entry.rank, 2);
    assert.equal(entry.score, 62);
    assert.equal(entry.summary, 'dup の見出し');
  });

  it('落とす側の keyword は拾う', () => {
    /*
     * バージョン文字列は release にしか無い。ここを落とすと
     * 「v2.1.225」で検索して出てこなくなる（keywords は検索対象に入っている）
     */
    const [entry] = toIndexEntries(
      digest({
        top: [top({ id: 'dup', keywords: ['Claude Code', 'エージェント'] })],
        releases: [release({ id: 'dup', product: 'Claude Code', version: 'v2.1.225' })],
      }),
    );

    assert.ok(entry);
    assert.deepEqual(entry.keywords, ['Claude Code', 'エージェント', 'v2.1.225']);
  });

  it('重複が無ければ全件そのまま入る', () => {
    const entries = toIndexEntries(
      digest({
        top: [top({ id: 'a' })],
        releases: [release({ id: 'b' })],
        others: [ranked({ id: 'c' })],
      }),
    );

    assert.deepEqual(
      entries.map((e) => e.id),
      ['a', 'b', 'c'],
    );
  });
});
