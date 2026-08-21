import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTrialReport } from './trial-report.js';

/*
 * ここで固定したいのは「走り切った実行を捨てない」こと。
 *
 * 実測（2026-08-21）で、7.6 分走って採点役が satisfied を返したレポートが、
 * 答えの 1 つが 400 字を 1 文字超えていただけで丸ごと拒否された。画面に残ったのは
 * 「レポートの形が想定と違います: Too big」だけで、実行も実費も戻らない。
 *
 * 長さ・件数・言い換え・欠落は**直して通す**。捨てるのは中身が無いときだけ。
 */

const ok = {
  verdict: 'worked',
  headline: '入った',
  answers: [{ question: '入るか', answer: '入った' }],
  steps: [{ command: 'npm i foo', ok: true, note: '11 秒' }],
  stumbles: [],
  correction: null,
};

describe('normalizeTrialReport', () => {
  it('そのまま通る形は変えない', () => {
    const r = normalizeTrialReport(ok);
    assert.equal(r?.verdict, 'worked');
    assert.equal(r?.headline, '入った');
    assert.equal(r?.answers.length, 1);
  });

  it('長すぎる答えは捨てずに切る', () => {
    const long = 'あ'.repeat(401);
    const r = normalizeTrialReport({ ...ok, answers: [{ question: 'q', answer: long }] });
    assert.ok(r, '長さで拒否してはいけない');
    assert.equal(Array.from(r!.answers[0]!.answer).length, 400);
    assert.ok(r!.answers[0]!.answer.endsWith('…'));
  });

  it('見出し・コマンド・詰まった点・訂正も同じように切る', () => {
    const r = normalizeTrialReport({
      ...ok,
      headline: 'い'.repeat(200),
      steps: [{ command: 'x'.repeat(400), ok: false, note: 'y'.repeat(400) }],
      stumbles: ['z'.repeat(400)],
      correction: 'w'.repeat(500),
    });
    assert.equal(Array.from(r!.headline).length, 120);
    assert.equal(Array.from(r!.steps[0]!.command).length, 300);
    assert.equal(Array.from(r!.steps[0]!.note).length, 300);
    assert.equal(Array.from(r!.stumbles[0]!).length, 300);
    assert.equal(Array.from(r!.correction!).length, 400);
  });

  it('多すぎる件数は捨てずに先頭だけ残す', () => {
    const r = normalizeTrialReport({
      ...ok,
      answers: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` })),
      steps: Array.from({ length: 30 }, () => ({ command: 'c', ok: true, note: 'n' })),
      stumbles: Array.from({ length: 9 }, (_, i) => `s${i}`),
    });
    assert.equal(r?.answers.length, 5);
    assert.equal(r?.steps.length, 20);
    assert.equal(r?.stumbles.length, 5);
  });

  it('判定の言い換えを吸収する', () => {
    for (const [raw, want] of [
      ['success', 'worked'],
      ['OK', 'worked'],
      ['partial', 'partly'],
      ['failure', 'failed'],
      ['blocked', 'failed'],
    ] as const) {
      assert.equal(normalizeTrialReport({ ...ok, verdict: raw })?.verdict, want, raw);
    }
  });

  it('判定が無い・知らない語のときはコマンドの成否から導く', () => {
    const allOk = normalizeTrialReport({
      ...ok,
      verdict: '',
      steps: [{ command: 'a', ok: true, note: '' }, { command: 'b', ok: true, note: '' }],
    });
    assert.equal(allOk?.verdict, 'worked');

    const allNg = normalizeTrialReport({
      ...ok,
      verdict: 'なんらかの語',
      steps: [{ command: 'a', ok: false, note: '' }],
    });
    assert.equal(allNg?.verdict, 'failed');

    const mixed = normalizeTrialReport({
      ...ok,
      verdict: undefined,
      steps: [{ command: 'a', ok: true, note: '' }, { command: 'b', ok: false, note: '' }],
    });
    assert.equal(mixed?.verdict, 'partly');
  });

  it('項目が欠けていても通す', () => {
    const r = normalizeTrialReport({ verdict: 'worked', headline: '入った' });
    assert.ok(r);
    assert.deepEqual(r!.answers, []);
    assert.deepEqual(r!.stumbles, []);
    assert.equal(r!.correction, null);
  });

  it('見出しが無ければ答えから作る（カードが名無しにならないように）', () => {
    const r = normalizeTrialReport({ ...ok, headline: '' });
    assert.equal(r?.headline, '入った');
  });

  it('中身が何も無いときだけ捨てる', () => {
    assert.equal(normalizeTrialReport({ verdict: 'worked', headline: '' }), null);
    assert.equal(normalizeTrialReport({}), null);
    assert.equal(normalizeTrialReport(null), null);
    assert.equal(normalizeTrialReport('レポートではない文字列'), null);
  });
});
