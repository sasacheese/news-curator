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
 * ▼▼▼ 動作確認用の一時設定。確認が終わったら null に戻すこと ▼▼▼
 *
 * 往復をこの秒数に固定する。本来は読了目安（20〜30 分）で 1 周するので、
 * 歩いているところや折り返しの吹き出しを目視するには待ち時間が長すぎる。
 * null にすると読了目安に連動する本来の挙動に戻る。
 */
const DEBUG_ROUND_TRIP_SECONDS: number | null = 10;

const DEFAULT_MINUTES = 20;
/** 極端な値でアニメーションが破綻しないように挟む */
const MIN_MINUTES = 3;
const MAX_MINUTES = 90;

let minutes = DEFAULT_MINUTES;
const listeners = new Set<() => void>();

export function setWalkMinutes(next: number): void {
  // 一時設定中はダイジェスト側の読了目安を無視する
  if (DEBUG_ROUND_TRIP_SECONDS !== null) return;
  const clamped = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(next)));
  if (clamped === minutes) return;
  minutes = clamped;
  for (const listener of listeners) listener();
}

export function getWalkMinutes(): number {
  if (DEBUG_ROUND_TRIP_SECONDS !== null) return DEBUG_ROUND_TRIP_SECONDS / 60;
  return minutes;
}

export function subscribeWalkMinutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
