import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupe, isBuzzing, pickByDomain, pickTopDiverse } from './prescore.js';
import type { Metrics, RawItem, SourceKind } from './types.js';

/*
 * ここで検証しているのは、このツールの実際の壊れ方に対応する不変条件。
 *
 * このツールは落ちずに劣化する（「静かな劣化」）。LLM の出力が仕様から外れると
 * ルールベースの既定値に落ちて、画面上はもっともらしいまま中身が失われる。
 * 選抜と重複排除は純粋関数なので、その中でも唯一ここだけは静的に固定できる。
 */

function item(over: Partial<RawItem> & { id: string }): RawItem {
  return {
    source: 'qiita',
    sourceLabel: 'Qiita',
    title: `記事 ${over.id}`,
    url: `https://example.com/${over.id}`,
    publishedAt: '2026-08-01T00:00:00.000Z',
    tags: [],
    snippet: '',
    metrics: {},
    lang: 'ja',
    sourceWeight: 1,
    ...over,
  };
}

function ranked(id: string, score: number, sourceLabel = id): {
  id: string;
  sourceLabel: string;
  score: number;
} {
  return { id, sourceLabel, score };
}

describe('pickTopDiverse', () => {
  it('同じソースに枠を独占させない', () => {
    // 同じ日に nodejs/node のリリースが 3 本出てもベスト3を占めさせない
    const got = pickTopDiverse(
      [
        ranked('a', 90, 'GitHub'),
        ranked('b', 89, 'GitHub'),
        ranked('c', 88, 'GitHub'),
        ranked('d', 50, 'Qiita'),
      ],
      2,
    );
    assert.deepEqual(
      got.map((i) => i.id),
      ['a', 'd'],
    );
  });

  it('ソースが足りなければ重複ソースで埋める（枠を空けない）', () => {
    const got = pickTopDiverse([ranked('a', 90, 'GitHub'), ranked('b', 80, 'GitHub')], 2);
    assert.equal(got.length, 2);
  });

  it('枠ルールを満たすため下位と入れ替える', () => {
    const got = pickTopDiverse(
      [ranked('ai1', 90), ranked('ai2', 80), ranked('general', 10)],
      2,
      [{ label: 'AI以外', match: (i) => i.id === 'general' }],
    );
    assert.ok(
      got.some((i) => i.id === 'general'),
      '枠ルールを満たす候補が選ばれていない',
    );
  });

  it('1位は枠確保のために押し出さない', () => {
    // その日の最重要が枠確保で消えるのは本末転倒
    const got = pickTopDiverse(
      [ranked('top', 99), ranked('mid', 80), ranked('slot', 5)],
      2,
      [{ label: '枠', match: (i) => i.id === 'slot' }],
    );
    assert.equal(got[0]?.id, 'top');
    assert.ok(got.some((i) => i.id === 'slot'));
  });

  it('他の枠が全部埋まっていても、1位を犠牲にするより枠を諦める', () => {
    // 2位が枠2を単独で満たしていると、枠1のための犠牲になれるのは1位しか残らない。
    // そこで1位を差し替えると「その日の最重要」が消えるので、枠1は諦めるのが正しい。
    const got = pickTopDiverse(
      [ranked('top', 99), ranked('slot2', 80), ranked('slot1', 5)],
      2,
      [
        { label: '枠1', match: (i) => i.id === 'slot1' },
        { label: '枠2', match: (i) => i.id === 'slot2' },
      ],
    );
    assert.ok(
      got.some((i) => i.id === 'top'),
      '1位が枠確保のために押し出された',
    );
    assert.ok(
      got.some((i) => i.id === 'slot2'),
      '単独で枠を満たしている記事が外された',
    );
  });

  it('枠ルールを満たす候補が無い日は黙って諦める', () => {
    const got = pickTopDiverse([ranked('a', 90), ranked('b', 80)], 2, [
      { label: '無い枠', match: (i) => i.id === 'zzz' },
    ]);
    assert.deepEqual(
      got.map((i) => i.id),
      ['a', 'b'],
    );
  });

  it('返す件数は n を超えず、重複しない', () => {
    const got = pickTopDiverse(
      [ranked('a', 90), ranked('b', 80), ranked('c', 70), ranked('d', 60)],
      3,
      [{ label: 'x', match: (i) => i.id === 'd' }],
    );
    assert.equal(got.length, 3);
    assert.equal(new Set(got.map((i) => i.id)).size, 3, '同じ記事が2回入っている');
  });
});

describe('pickByDomain', () => {
  const ai = (id: string) => ({ id, domain: 'ai' as const });
  const general = (id: string) => ({ id, domain: 'general' as const });

  it('AI に偏った母集団でも AI 以外の枠を確保する', () => {
    // 実測で採点上位 15 件のうち 13〜15 件が AI だった
    const pool = [...Array.from({ length: 14 }, (_, i) => ai(`ai${i}`)), general('g0'), general('g1')];
    const { ai: pickedAi, general: pickedGeneral } = pickByDomain(pool, 9);
    assert.equal(pickedGeneral.length, 2, 'AI以外が確保されていない');
    assert.equal(pickedAi.length + pickedGeneral.length, 9);
  });

  it('AI 側が足りなければ AI 以外で埋め戻す', () => {
    const pool = [ai('ai0'), ...Array.from({ length: 8 }, (_, i) => general(`g${i}`))];
    const { ai: pickedAi, general: pickedGeneral } = pickByDomain(pool, 6);
    assert.equal(pickedAi.length, 1);
    assert.equal(pickedAi.length + pickedGeneral.length, 6);
  });

  it('埋め戻しで同じ記事を二重に入れない', () => {
    const pool = [ai('ai0'), general('g0'), general('g1'), general('g2')];
    const { ai: a, general: g } = pickByDomain(pool, 4);
    const ids = [...a, ...g].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, '同じ記事が AI 枠と AI以外 枠の両方に入っている');
  });

  it('母集団が総数に足りない日は水増ししない', () => {
    const { ai: a, general: g } = pickByDomain([ai('ai0'), general('g0')], 10);
    assert.equal(a.length + g.length, 2);
  });
});

describe('dedupe', () => {
  it('トラッキングパラメータ違いを同一視する', () => {
    const got = dedupe(
      [
        item({ id: '1', url: 'https://example.com/a?utm_source=x' }),
        item({ id: '2', url: 'https://example.com/a' }),
      ],
      new Set(),
    );
    assert.equal(got.length, 1);
  });

  it('複数ソースから来た記事の foundIn を全部覚える', () => {
    // はてブ経由かどうかが話題性判定の一番強い根拠になるので、失うと buzz が落ちる
    const got = dedupe(
      [
        item({ id: '1', url: 'https://example.com/a', source: 'qiita' }),
        item({ id: '2', url: 'https://example.com/a', source: 'hatena' }),
      ],
      new Set(),
    );
    assert.deepEqual([...(got[0]?.foundIn ?? [])].sort(), ['hatena', 'qiita']);
  });

  it('メトリクスは大きい方を残す', () => {
    const got = dedupe(
      [
        item({ id: '1', url: 'https://example.com/a', metrics: { likes: 3 } }),
        item({ id: '2', url: 'https://example.com/a', metrics: { likes: 40, hatena: 12 } }),
      ],
      new Set(),
    );
    assert.equal(got[0]?.metrics.likes, 40);
    assert.equal(got[0]?.metrics.hatena, 12);
  });

  it('本文が長い方を代表にする', () => {
    const got = dedupe(
      [
        item({ id: 'short', url: 'https://example.com/a', body: 'あ' }),
        item({ id: 'long', url: 'https://example.com/a', body: 'あ'.repeat(500) }),
      ],
      new Set(),
    );
    assert.equal(got[0]?.id, 'long');
  });

  it('http/https 以外の URL を落とす', () => {
    // 外部 API / RSS の link は信用しない
    const got = dedupe(
      [item({ id: '1', url: 'javascript:alert(1)' }), item({ id: '2', url: 'https://example.com/ok' })],
      new Set(),
    );
    assert.deepEqual(
      got.map((i) => i.url),
      ['https://example.com/ok'],
    );
  });

  it('過去に出したURLを落とす', () => {
    const got = dedupe([item({ id: '1', url: 'https://example.com/a' })], new Set(['https://example.com/a']));
    assert.equal(got.length, 0);
  });

  it('タイトルが記号違いだけの記事を落とす', () => {
    const got = dedupe(
      [
        item({ id: '1', url: 'https://example.com/a', title: 'React 19 の新機能まとめ' }),
        item({ id: '2', url: 'https://example.com/b', title: 'React 19 の新機能まとめ！' }),
      ],
      new Set(),
    );
    assert.equal(got.length, 1);
  });

  it('タイトルが短い記事は近似判定にかけない', () => {
    // 8文字未満のキーは衝突しやすいので、別記事を消してはいけない
    const got = dedupe(
      [
        item({ id: '1', url: 'https://example.com/a', title: 'v2.0' }),
        item({ id: '2', url: 'https://example.com/b', title: 'v2.0' }),
      ],
      new Set(),
    );
    assert.equal(got.length, 2);
  });
});

describe('isBuzzing', () => {
  const buzz = (source: SourceKind, metrics: Metrics, foundIn?: SourceKind[]) =>
    isBuzzing(item({ id: 'x', source, metrics, foundIn }));

  it('はてブのホットエントリー掲載は無条件で話題', () => {
    assert.equal(buzz('qiita', {}, ['qiita', 'hatena']), true);
  });

  it('他ソース由来でもはてブが5件付いていれば話題', () => {
    assert.equal(buzz('zenn', { hatena: 5 }), true);
    assert.equal(buzz('zenn', { hatena: 4 }), false);
  });

  it('Qiita / Zenn は LGTM + ストック×0.5 で 10 以上', () => {
    assert.equal(buzz('qiita', { likes: 10 }), true);
    assert.equal(buzz('qiita', { likes: 8, stocks: 4 }), true);
    assert.equal(buzz('qiita', { likes: 9 }), false);
  });

  it('Hacker News は 300 points 以上', () => {
    assert.equal(buzz('hackernews', { points: 300 }), true);
    // 中央値は 116。ここを下げると毎日大量に付いて意味を失う
    assert.equal(buzz('hackernews', { points: 120 }), false);
  });

  it('GitHub リポジトリは 3000 star 以上', () => {
    assert.equal(buzz('github_repo', { stars: 3000 }), true);
    assert.equal(buzz('github_repo', { stars: 1045 }), false);
  });

  it('指標を持たない一次情報は、はてブが付かないかぎり話題にしない', () => {
    assert.equal(buzz('changelog', {}), false);
    assert.equal(buzz('github_release', {}), false);
    assert.equal(buzz('rss', { hatena: 8 }), true);
  });
});
