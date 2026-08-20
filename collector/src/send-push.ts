import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { sendPushToAll, siteUrl, type PushPayload } from './push.js';
import type { Digest, Manifest } from './types.js';

/**
 * 当日のダイジェスト完成後に、購読中の全端末へ Web Push を送る。
 *
 * ワークフローでは Pages のデプロイ**後**に実行する。通知を先に出すと、
 * タップした先がまだ前日のままということが起きる。
 *
 * 送信そのもの（VAPID の設定・失効した購読の掃除）は push.ts に置いてある。
 * ここが持つのは「朝のダイジェストの通知はどういう文面か」だけ。
 */

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 通知の本文。ダイジェストが読めない日でも通知自体は出す */
function buildPayload(manifest: Manifest | null, digest: Digest | null): PushPayload {
  const date = digest?.date ?? manifest?.latest ?? null;
  const title = date ? `${date} のダイジェスト` : '今朝のダイジェスト';

  let body = '今朝のダイジェストができました。';
  if (digest) {
    const minutes = digest.stats.estimatedReadMinutes;
    const parts = [
      `深掘り ${digest.top.length} 本`,
      `リリース ${digest.releases.length} 件`,
      `その他 ${digest.others.length} 件`,
    ];
    body = `${parts.join('・')}。読了目安 約 ${minutes} 分。`;
  }

  return {
    title,
    body,
    url: siteUrl(manifest?.repo),
    tag: 'daily-digest',
    // 朝のうちに届かなければ価値が無いので、半日で破棄させる
    ttlSeconds: 12 * 3600,
  };
}

async function main(): Promise<void> {
  const manifest = await readJsonOrNull<Manifest>(resolve(DATA_DIR, 'manifest.json'));
  const digest = manifest?.latest
    ? await readJsonOrNull<Digest>(resolve(DATA_DIR, 'digests', `${manifest.latest}.json`))
    : null;

  await sendPushToAll(buildPayload(manifest, digest));
}

await main();
