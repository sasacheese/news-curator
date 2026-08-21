import { TrialReportSchema } from './schemas.js';
import type { TrialAnswer, TrialStep, TrialVerdict } from './types.js';

/**
 * サンドボックスが書いた JSON を、画面に載せられる形に整える。
 *
 * **ここは「直せるものは直して通す」層である。** 以前は表示用の長さの上限を
 * 検証スキーマに書いていて、401 字の答えが 1 つあるだけでレポート全体を捨てていた。
 * 実測で、7.6 分走って採点役が satisfied を返した実行が丸ごと失敗になり、
 * 画面には「Too big」だけが残った。長さは表示の都合であって受理の条件ではない。
 *
 * 捨てるのは**中身が何も無いとき**だけ。それ以外は切り詰め・既定値・導出で通す。
 * 対象ツールの README やエラー文が混ざりうる出力なので、長さを縛る必要そのものは
 * 変わらない——縛る場所を「受理」から「保存」に移しただけ。
 */

/** 表示用の上限。超えた分は末尾を … にして切る */
const LIMIT = {
  headline: 120,
  question: 200,
  answer: 400,
  command: 300,
  note: 300,
  stumble: 300,
  correction: 400,
} as const;

/** 件数の上限。超えた分は捨てる（読み切れない量を画面に出さない） */
const MAX = { answers: 5, steps: 20, stumbles: 5 } as const;

export interface NormalizedTrialReport {
  verdict: TrialVerdict;
  headline: string;
  answers: TrialAnswer[];
  steps: TrialStep[];
  stumbles: string[];
  correction: string | null;
}

/** 長さを切る。1 文字超えただけで全体を捨てない代わりに、必ずここを通す */
function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 判定の言い換えを吸収する。
 *
 * プロンプトでは 3 語に限っているが、モデルは `success` / `ok` / `partial` /
 * `failure` を書くことがある。ここで拾えないものは steps から導く。
 */
function normalizeVerdict(raw: string, steps: TrialStep[]): TrialVerdict {
  const v = raw.trim().toLowerCase();
  if (['worked', 'success', 'succeeded', 'ok', 'pass', 'passed'].includes(v)) return 'worked';
  if (['partly', 'partial', 'partially', 'mixed'].includes(v)) return 'partly';
  if (['failed', 'failure', 'fail', 'error', 'blocked'].includes(v)) return 'failed';

  // 書かれていない・知らない語のときは、実際に打ったコマンドの成否から決める
  if (steps.length === 0) return 'partly';
  const ok = steps.filter((s) => s.ok).length;
  if (ok === steps.length) return 'worked';
  if (ok === 0) return 'failed';
  return 'partly';
}

/**
 * @returns 整えたレポート。中身が何も無ければ null（そのときだけ失敗として扱う）
 */
export function normalizeTrialReport(raw: unknown): NormalizedTrialReport | null {
  const parsed = TrialReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;

  const steps: TrialStep[] = d.steps
    .slice(0, MAX.steps)
    .map((s) => ({
      command: clamp(s.command, LIMIT.command),
      ok: s.ok,
      note: clamp(s.note, LIMIT.note),
    }))
    .filter((s) => s.command || s.note);

  const answers: TrialAnswer[] = d.answers
    .slice(0, MAX.answers)
    .map((a) => ({
      question: clamp(a.question, LIMIT.question),
      answer: clamp(a.answer, LIMIT.answer),
    }))
    .filter((a) => a.answer);

  const stumbles = d.stumbles
    .slice(0, MAX.stumbles)
    .map((v) => clamp(v, LIMIT.stumble))
    .filter(Boolean);

  /*
   * 結論の 1 行が無いとカードが名無しになるので、答えかコマンドの記録から拾う。
   * ここまで何も無ければ、そのレポートは読者に何も渡せないので捨てる。
   */
  let headline = clamp(d.headline, LIMIT.headline);
  if (!headline) headline = answers[0]?.answer ?? steps.find((s) => s.note)?.note ?? '';
  if (!headline && answers.length === 0 && steps.length === 0) return null;

  const correction = clamp(d.correction ?? '', LIMIT.correction);

  return {
    verdict: normalizeVerdict(d.verdict, steps),
    headline: clamp(headline, LIMIT.headline),
    answers,
    steps,
    stumbles,
    correction: correction || null,
  };
}
