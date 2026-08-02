import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveImpact, sortReleases } from './releases.js';
import type { ReleaseImpact, ReleaseItem } from './types.js';

/*
 * リリース情報の並べ替えと分類の補正。
 *
 * このツールの壊れ方は「落ちずに劣化する」なので、LLM が
 * 分類だけ立派で中身が空のものを返したときに、画面がそれらしく見えてしまうのが怖い。
 * 分類とテキストの食い違いを構造で潰す部分をここで固定する。
 */

describe('resolveImpact', () => {
  it('中身のある unlock はそのまま通す', () => {
    const r = resolveImpact('unlocks', 'iPhone からも同じ拡張機能が使えるようになる');
    assert.equal(r.impact, 'unlocks');
    assert.equal(r.unlock, 'iPhone からも同じ拡張機能が使えるようになる');
  });

  it('unlock が無いのに unlocks と言うものは chore に落とす', () => {
    // 「大きな変更です」と言いながら中身を書けないことがある
    assert.deepEqual(resolveImpact('unlocks', null), { impact: 'chore', unlock: null });
    assert.deepEqual(resolveImpact('unlocks', '   '), { impact: 'chore', unlock: null });
  });

  it('当たり障りのない unlock は中身なしとみなす', () => {
    // 埋めるために書かれる定型文。これを通すと chore が unlocks に混ざる
    for (const vague of [
      '安定性が向上する',
      '信頼性が向上します',
      '複数のバグが修正される',
      '不具合が修正されている',
    ]) {
      const r = resolveImpact('unlocks', vague);
      assert.equal(r.impact, 'chore', `「${vague}」が通ってしまった`);
      assert.equal(r.unlock, null);
    }
  });

  it('「なし」などの空値表現も落とす', () => {
    for (const empty of ['なし', '特になし', '不明', 'null', '-', '—']) {
      assert.equal(resolveImpact('unlocks', empty).unlock, null, `「${empty}」が通ってしまった`);
    }
  });

  it('unlock があるのに chore と言うものは improves まで上げる', () => {
    // unlocks まで上げるのは踏み込みすぎなので improves で止める
    const r = resolveImpact('chore', 'ビルド結果をリモートキャッシュから共有できるようになる');
    assert.equal(r.impact, 'improves');
  });

  it('security は unlock の有無で判断しない', () => {
    // 修正版の案内が unlock に入るので、空でも security のまま
    assert.equal(resolveImpact('security', null).impact, 'security');
    assert.equal(resolveImpact('security', '4.31.0 以降に上げると塞がる').impact, 'security');
  });

  it('知らない値は chore に丸める', () => {
    assert.equal(resolveImpact('breaking', null).impact, 'chore');
    assert.equal(resolveImpact(undefined, null).impact, 'chore');
  });
});

function rel(over: Partial<ReleaseItem> & { id: string; impact: ReleaseImpact }): ReleaseItem {
  return {
    product: over.id,
    what: null,
    version: null,
    kind: 'minor',
    unlock: null,
    change: null,
    scope: [],
    summary: '',
    title: over.id,
    url: `https://example.com/${over.id}`,
    sourceLabel: 'test',
    publishedAt: '2026-08-01T00:00:00.000Z',
    alsoReleased: [],
    ...over,
  };
}

describe('sortReleases', () => {
  it('impact の順に並べる（できるようになる → 脆弱性 → 改善 → 修正のみ）', () => {
    const got = sortReleases([
      rel({ id: 'chore', impact: 'chore' }),
      rel({ id: 'improves', impact: 'improves' }),
      rel({ id: 'security', impact: 'security' }),
      rel({ id: 'unlocks', impact: 'unlocks' }),
    ]);
    assert.deepEqual(
      got.map((r) => r.id),
      ['unlocks', 'security', 'improves', 'chore'],
    );
  });

  it('脆弱性は深刻度の高いものを先に出す', () => {
    const advisory = (severity: 'critical' | 'high' | 'medium') => ({
      cveId: null,
      ghsaId: `GHSA-${severity}`,
      severity,
      cvss: null,
      packageName: 'pkg',
      patchedVersion: null,
    });
    const got = sortReleases([
      rel({ id: 'medium', impact: 'security', advisory: advisory('medium') }),
      rel({ id: 'critical', impact: 'security', advisory: advisory('critical') }),
      rel({ id: 'high', impact: 'security', advisory: advisory('high') }),
    ]);
    assert.deepEqual(
      got.map((r) => r.id),
      ['critical', 'high', 'medium'],
    );
  });

  it('同じ impact なら新しいものを先に出す', () => {
    const got = sortReleases([
      rel({ id: 'old', impact: 'unlocks', publishedAt: '2026-08-01T01:00:00.000Z' }),
      rel({ id: 'new', impact: 'unlocks', publishedAt: '2026-08-01T09:00:00.000Z' }),
    ]);
    assert.deepEqual(
      got.map((r) => r.id),
      ['new', 'old'],
    );
  });

  it('元の配列を壊さない', () => {
    const input = [rel({ id: 'a', impact: 'chore' }), rel({ id: 'b', impact: 'unlocks' })];
    sortReleases(input);
    assert.deepEqual(
      input.map((r) => r.id),
      ['a', 'b'],
    );
  });
});
