import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeShortlist, sanitizeTrial } from './llm.js';
import { pickTopDiverse } from './prescore.js';
import type { PreScoredItem } from './types.js';

/*
 * ここで固定したいのは「要約されていない項目がベストに選ばれない」こと。
 *
 * 選ばれてしまった日は、3 行要約もキーワードも空・カテゴリは「その他」のカードが
 * 画面に出る。カードとしては成立してしまうので、実行ログを見ないと気づけない。
 * 実測で、話すレーンの上位 5 件が全部 Qiita だった日に 6 番目（60 点・hackernews）が
 * 「1 ソース 1 件」の多様化で繰り上がり、この壊れ方をした。
 */

function item(over: Partial<PreScoredItem> & { id: string }): PreScoredItem {
  return {
    source: 'qiita',
    sourceLabel: 'Qiita',
    title: `記事 ${over.id}`,
    url: `https://example.com/${over.id}`,
    publishedAt: '2026-08-18T00:00:00.000Z',
    tags: [],
    snippet: '',
    metrics: {},
    lang: 'ja',
    sourceWeight: 1,
    preScore: 0.3,
    buzz: false,
    popularityPercentile: 0.5,
    matchedTopics: [],
    ...over,
  };
}

const TOP_N = 2;
const OTHER_N = 12;

describe('describeShortlist', () => {
  it('スコア上位が同じソースで埋まっていても、多様化が拾う項目を含む', () => {
    // 上位 20 件が Qiita、その後ろに 1 件だけ別ソース。実データで踏んだ形
    const items = [
      ...Array.from({ length: 20 }, (_, i) =>
        item({ id: `q${i}`, preScore: (100 - i) / 100 }),
      ),
      item({ id: 'hn', source: 'hackernews', sourceLabel: 'Hacker News', preScore: 0.6 }),
    ];
    const scoreOf = (i: PreScoredItem) => Math.round(i.preScore * 100);

    const shortlist = describeShortlist(items, scoreOf, TOP_N, OTHER_N);
    const ids = new Set(shortlist.map((i) => i.id));

    // 選抜側が実際に選ぶものを、そのまま突き合わせる
    const picked = pickTopDiverse(
      [...items].sort((a, b) => scoreOf(b) - scoreOf(a)).map((i) => ({ ...i, score: scoreOf(i) })),
      TOP_N,
    );
    assert.ok(
      picked.some((p) => p.id === 'hn'),
      '前提が崩れている: 多様化が別ソースを拾っていない',
    );
    for (const p of picked) {
      assert.ok(ids.has(p.id), `ベストに選ばれる ${p.id} が要約対象に入っていない`);
    }
  });

  it('一次情報はスコアが低くても含む（枠確保がスコア順の外から拾うため）', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item({ id: `q${i}`, preScore: (100 - i) / 100 })),
      item({ id: 'feed', source: 'rss', sourceLabel: '公式ブログ', preScore: 0.05 }),
    ];
    const shortlist = describeShortlist(items, (i) => Math.round(i.preScore * 100), TOP_N, OTHER_N);
    assert.ok(shortlist.some((i) => i.id === 'feed'));
  });

  it('同じ項目を二重に入れない', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({ id: `q${i}`, preScore: (100 - i) / 100 }),
    );
    const shortlist = describeShortlist(items, (i) => Math.round(i.preScore * 100), TOP_N, OTHER_N);
    assert.equal(new Set(shortlist.map((i) => i.id)).size, shortlist.length);
  });
});

/*
 * ここで固定したいのは「試せないものにボタンを出さない」こと。
 *
 * 壊れ方が静かなのが厄介で、install が「公式サイトを開く」の計画でもボタンは出て、
 * 押した読者はレポートを待ち、20 分後に失敗ログだけが返る。画面には成功と失敗の
 * 区別が付かない形で残るので、通す前に落とす。
 */
describe('sanitizeTrial', () => {
  const ok = {
    runner: 'node' as const,
    install: 'npm i -g foo@latest',
    verify: 'foo --version',
    questions: ['README の 3 ステップで最初の出力まで行けるか'],
  };

  it('コマンドと問いが揃っていれば通す', () => {
    assert.deepEqual(sanitizeTrial(ok), ok);
  });

  it('前後の空白は落として通す', () => {
    const got = sanitizeTrial({ ...ok, install: '  npm i -g foo@latest  ' });
    assert.equal(got?.install, 'npm i -g foo@latest');
  });

  it('人間しか踏めない手順が入っていたら落とす', () => {
    assert.equal(sanitizeTrial({ ...ok, install: '公式サイトからダウンロードする' }), null);
    assert.equal(sanitizeTrial({ ...ok, verify: 'ブラウザで開いて表示を確認する' }), null);
    assert.equal(sanitizeTrial({ ...ok, install: 'Sign up for an API key' }), null);
  });

  it('URL だけの install は入手先の案内であってコマンドではない', () => {
    assert.equal(sanitizeTrial({ ...ok, install: 'https://example.com/download' }), null);
  });

  it('複数行の手順書は落とす（半端に実行させない）', () => {
    assert.equal(sanitizeTrial({ ...ok, install: 'git clone x\ncd x\nnpm i' }), null);
  });

  it('問いが無ければ落とす（動作確認だけでは読者に残らない）', () => {
    assert.equal(sanitizeTrial({ ...ok, questions: [] }), null);
    assert.equal(sanitizeTrial({ ...ok, questions: ['  ', ''] }), null);
  });

  it('問いは 3 個まで', () => {
    const got = sanitizeTrial({ ...ok, questions: ['a', 'b', 'c', 'd'] });
    assert.deepEqual(got?.questions, ['a', 'b', 'c']);
  });

  it('null / undefined はそのまま落とす', () => {
    assert.equal(sanitizeTrial(null), null);
    assert.equal(sanitizeTrial(undefined), null);
  });
});
