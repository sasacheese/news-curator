import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dedupeByIncident,
  knownIncidentLabels,
  normalizeIncidentKey,
  previousSummary,
  updateIncidentLedger,
} from './incidents.js';

describe('normalizeIncidentKey', () => {
  it('空白・記号・全角半角の違いを吸収する', () => {
    assert.equal(normalizeIncidentKey('アスクル ランサムウェア'), normalizeIncidentKey('アスクル・ランサムウェア'));
    assert.equal(normalizeIncidentKey('ＮＰＭ サプライチェーン攻撃'), normalizeIncidentKey('npm サプライチェーン攻撃'));
  });
});

describe('dedupeByIncident', () => {
  it('同じ事案は先頭（スコア最上位）だけ残し、事案の無い記事は残す', () => {
    const got = dedupeByIncident([
      { id: 'a', incident: 'X社 不正アクセス' },
      { id: 'b', incident: null },
      { id: 'c', incident: 'X社　不正アクセス' },
      { id: 'd', incident: null },
    ]);
    assert.deepEqual(
      got.map((i) => i.id),
      ['a', 'b', 'd'],
    );
  });

  it('除外キーに入っている事案は落とす（深掘り済みの事案を一覧に重ねない）', () => {
    const got = dedupeByIncident([{ id: 'a', incident: 'Y社 漏洩' }], new Set([normalizeIncidentKey('Y社 漏洩')]));
    assert.equal(got.length, 0);
  });
});

describe('台帳', () => {
  it('続報には前回の要約を返し、今日はじめての事案には返さない', () => {
    let ledger = updateIncidentLedger({}, '2026-10-10', [
      { incident: 'Z社 ランサムウェア', summary: '初報の要約', deep: true },
    ]);
    assert.equal(previousSummary(ledger, 'Z社 ランサムウェア', '2026-10-10'), null);
    assert.equal(previousSummary(ledger, 'Z社ランサムウェア', '2026-10-12'), '初報の要約');

    ledger = updateIncidentLedger(ledger, '2026-10-12', [
      { incident: 'Z社 ランサムウェア', summary: '一覧の1行', deep: false },
    ]);
    // 一覧の 1 行では深掘りの要約を上書きしない
    assert.equal(ledger[normalizeIncidentKey('Z社 ランサムウェア')]!.summary, '初報の要約');
    assert.equal(ledger[normalizeIncidentKey('Z社 ランサムウェア')]!.lastSeen, '2026-10-12');
  });

  it('保持期間を過ぎた事案は落とす', () => {
    const ledger = updateIncidentLedger(
      { old: { label: 'old', firstSeen: '2026-08-01', lastSeen: '2026-08-01', summary: '' } },
      '2026-10-10',
      [],
    );
    assert.deepEqual(Object.keys(ledger), []);
  });

  it('既知のキーは新しい順に返す', () => {
    const labels = knownIncidentLabels({
      a: { label: 'A', firstSeen: '2026-10-01', lastSeen: '2026-10-01', summary: '' },
      b: { label: 'B', firstSeen: '2026-10-02', lastSeen: '2026-10-05', summary: '' },
    });
    assert.deepEqual(labels, ['B', 'A']);
  });
});
