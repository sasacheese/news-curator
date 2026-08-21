import { TrialButton } from './TrialButton';
import { TrialReportView } from './TrialReport';
import { trialKey, useTrialReports, type TrialTarget } from './trial';
import type { TrialPlan } from './types';

/**
 * 「試させる依頼」と「試した結果」のどちらを出すかを決めるだけの枠。
 *
 * 出す場所が 4 つある（ベスト3の作るレーン / その他候補 / リリース情報 / 発掘）ので、
 * 呼び出し側を 1 行で済ませるためにここへ寄せた。判断は 2 つだけ:
 *
 * - 結果が出ているなら結果を出す（依頼ボタンは消す）
 * - 結果がまだなら、試せるものにだけ依頼ボタンを出す（自分の端末だけ）
 *
 * `compact` は小さいカード（その他候補・リリース情報）向け。結果を畳んで、
 * 1 行の結論だけを見せる——一覧の行の中に本文級の箱が開くと、一覧が読めなくなる。
 */
export function TrialSlot({
  plan,
  target,
  compact = false,
}: {
  plan: TrialPlan | null | undefined;
  target: TrialTarget;
  compact?: boolean;
}) {
  const reports = useTrialReports();
  const report = reports.get(trialKey(target.digestDate, target.itemId));

  if (report) return <TrialReportView report={report} compact={compact} />;
  if (!plan) return null;
  return <TrialButton plan={plan} target={target} compact={compact} />;
}
