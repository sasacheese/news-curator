/**
 * 猫が往復にかける時間の受け渡し。
 *
 * 猫は App 直下にいて、読了目安を持っているのは TodayView なので、
 * props で降ろせない。購読するだけの小さな置き場を挟む。
 *
 * 「読了目安ぴったりで往復し終わる」ようにしたいので、往復 1 周 = 読了分数。
 * 読み終わる頃に猫が出発点へ戻ってくる。
 */

/*
 * 歩く速さを目で確かめたいときは DEFAULT_MINUTES を一時的に小さくする
 * （MIN_MINUTES も下げる必要がある）。専用の切り替えスイッチは置かない——
 * 休眠したデバッグ用の定数が残ると、10 秒で走り回る猫をそのまま本番に
 * 出してしまう余地が残る。
 */
const DEFAULT_MINUTES = 20;
/** 極端な値でアニメーションが破綻しないように挟む */
const MIN_MINUTES = 3;
const MAX_MINUTES = 90;

let minutes = DEFAULT_MINUTES;
const listeners = new Set<() => void>();

export function setWalkMinutes(next: number): void {
  const clamped = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(next)));
  if (clamped === minutes) return;
  minutes = clamped;
  for (const listener of listeners) listener();
}

export function getWalkMinutes(): number {
  return minutes;
}

export function subscribeWalkMinutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
