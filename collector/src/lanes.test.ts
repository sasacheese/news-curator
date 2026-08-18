import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignLane, laneAffinity, selectLaneCandidates } from './lanes.js';
import type { PreScoredItem } from './types.js';

/*
 * ここで固定したいのは、レーン分割が「何を測らないか」の側。
 *
 * このツールの過去の壊れ方は、単一のスコアに畳んだ結果いちばん測りやすい指標
 * （関心キーワードの一致）が全部を取る、というものだった。だから
 * 「know はトピック一致で動かない」「build は既知の語ばかりだと下がる」といった
 * 逆向きの性質を、実装が変わっても保つように書いている。
 */

function item(over: Partial<PreScoredItem> & { id: string }): PreScoredItem {
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
    preScore: 0.3,
    buzz: false,
    popularityPercentile: 0.5,
    matchedTopics: [],
    ...over,
  };
}

const THRESHOLDS = { know: 0.42, talk: 0.4 };

describe('laneAffinity', () => {
  it('know は関心トピックに一致しなくても規模で拾う', () => {
    // 読者の topics.json にハードウェアの価格の話は無い。それでも拾えないと
    // 「関心の外の重大事」が構造的に落ちる
    const big = item({
      id: 'a',
      title: 'PC 向け DRAM の供給不足で価格が高騰、大規模な調達計画の見直しへ',
      matchedTopics: [],
      preScore: 0.05,
    });
    const a = laneAffinity(big);
    assert.ok(a.know >= THRESHOLDS.know, `know=${a.know} がしきい値に届いていない`);
  });

  it('know は幹より枝を低く見る', () => {
    const trunk = item({
      id: 'trunk',
      title: 'npm に大規模なサプライチェーン攻撃、多数のパッケージが改ざん',
    });
    const branch = item({
      id: 'branch',
      title: 'サプライチェーン攻撃の続報: 個別パッケージのパッチが公開された',
    });
    const t = laneAffinity(trunk).know;
    const b = laneAffinity(branch).know;
    assert.ok(t > b, `幹 ${t} が枝 ${b} を上回っていない`);
  });

  it('複数のプラットフォームで同時に浮上したものを規模の証拠として扱う', () => {
    const base = { id: 'x', title: '主要クラウドで大規模障害が発生している' };
    const single = laneAffinity(item({ ...base, foundIn: ['qiita'] })).know;
    const multi = laneAffinity(item({ ...base, foundIn: ['qiita', 'hackernews', 'hatena'] })).know;
    assert.ok(multi > single);
  });

  /*
   * 以前は「過去のダイジェストに出ていない語の割合」に最大の重みを与えていた。
   * あれは新しさではなく無名さを測っていて、誰も知らない個人リポジトリが満点を取り、
   * 有名なツールの重要なリリースが沈んでいた。同じ壊れ方に戻らないよう固定する。
   */
  it('build は語が無名なだけでは加点しない', () => {
    const unknown = item({ id: 'u', title: 'Zigmond と Quarrelo を組み合わせて動かしてみた' });
    const known = item({ id: 'k', title: 'React と Nextjs と TypeScript の構成を見直す' });
    assert.equal(laneAffinity(unknown).build, laneAffinity(known).build);
  });

  it('build は「今日動かせる形か」をいちばん強い証拠にする', () => {
    // 触れる実体（0.4）が、新しさの語彙（0.35）より強く効くこと
    const tangible = item({ id: 't', snippet: 'npm install して使い方を見る' });
    const announced = item({ id: 'a', snippet: 'introducing 新しい仕組みを announcing' });
    assert.ok(
      laneAffinity(tangible).build > laneAffinity(announced).build,
      '試せるものが、告知だけのものを上回っていない',
    );
  });

  it('build はリポジトリそのものを「触れる実体」として扱う', () => {
    const repo = item({ id: 'r', source: 'github_repo', sourceLabel: 'GitHub 新着リポジトリ' });
    const post = item({ id: 'p' });
    assert.ok(laneAffinity(repo).build > laneAffinity(post).build);
  });

  it('talk は支持数の割にコメントが多いものを論争として拾う', () => {
    // 賛同だけなら star が伸びてコメントは伸びない。割れるとコメント側が伸びる
    const quiet = item({ id: 'q', metrics: { points: 300, comments: 8 } });
    const loud = item({ id: 'l', metrics: { points: 300, comments: 240 } });
    const qv = laneAffinity(quiet).talk;
    const lv = laneAffinity(loud).talk;
    assert.ok(lv > qv, `論争 ${lv} が静か ${qv} を上回っていない`);
  });

  it('talk は「やめた」「べきか」の形を拾う', () => {
    const opinion = item({ id: 'o', title: 'モノレポをやめた。本当に必要だったのかを再考する' });
    const neutral = item({ id: 'n', title: 'モノレポの構成手順' });
    assert.ok(
      laneAffinity(opinion).talk > laneAffinity(neutral).talk,
    );
  });
});

describe('assignLane', () => {
  it('どのレーンの要件も満たさないものは build に落ちる', () => {
    assert.equal(assignLane({ know: 0.1, build: 0.2, talk: 0.1 }, THRESHOLDS), 'build');
  });

  it('know を talk より優先する', () => {
    assert.equal(assignLane({ know: 0.9, build: 0.1, talk: 0.9 }, THRESHOLDS), 'know');
  });

  it('build のスコアが高くても know の要件を満たせば know にする', () => {
    // build は既定のレーンであって、勝ち取るレーンではない
    assert.equal(assignLane({ know: 0.5, build: 0.99, talk: 0.1 }, THRESHOLDS), 'know');
  });
});

describe('selectLaneCandidates', () => {
  it('1 件は 1 レーンにしか入らない', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({
        id: `i${i}`,
        title: i % 3 === 0 ? '大規模な脆弱性が見つかり緊急の対応が必要' : `記事 ${i}`,
        metrics: i % 5 === 0 ? { points: 100, comments: 90 } : {},
      }),
    );
    const { candidates } = selectLaneCandidates(items, 5, THRESHOLDS);
    const ids = [...candidates.know, ...candidates.build, ...candidates.talk].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, '同じ記事が複数のレーンに入っている');
  });

  it('しきい値に届くものが無い日でも、そのレーンを空にしない', () => {
    // 空になるのは「その日は該当が無かった」ではなく「しきい値がずれていた」
    // 可能性が高い。LLM に見せる前に枠を捨ててしまうと、そもそも判定できない
    const items = Array.from({ length: 20 }, (_, i) => item({ id: `i${i}` }));
    const { candidates } = selectLaneCandidates(items, 3, THRESHOLDS);
    assert.ok(candidates.know.length > 0, 'know が空のまま');
    assert.ok(candidates.talk.length > 0, 'talk が空のまま');
  });

  it('母集団が枠に足りない日は水増ししない', () => {
    const { candidates } = selectLaneCandidates(
      [item({ id: 'a' }), item({ id: 'b' })],
      10,
      THRESHOLDS,
    );
    const total = candidates.know.length + candidates.build.length + candidates.talk.length;
    assert.equal(total, 2);
  });
});
