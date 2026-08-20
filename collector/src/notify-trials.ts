import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { sendPushToAll, siteUrl } from './push.js';
import { loadTrialBoard } from './store.js';
import type { Manifest } from './types.js';
import { log } from './util.js';

/**
 * 出来たばかりのレポートを通知する。**Pages のデプロイ後**に呼ぶこと。
 *
 * 「読んで、投げて、仕事に戻って、一服するときに結果を見る」がこの機能の体験なので、
 * 戻ってくる合図が無いと、押したことを忘れて終わる。逆に、デプロイ前に送ると
 * タップした先にまだ結果が無い（朝のダイジェストと同じ順序の問題）。
 *
 * どのレポートが今回のぶんかは、鍵を引き回さずに **ranAt が直近かどうか**で決める。
 * 1 回の実行で走るのは数件で、cron の間隔も 15 分なので、時刻で足りる。
 */

const WINDOW_MIN = Number(process.env.TRIAL_NOTIFY_WINDOW_MIN) || 60;

async function main(): Promise<void> {
  const board = await loadTrialBoard();
  const since = Date.now() - WINDOW_MIN * 60_000;
  const fresh = board.reports.filter((r) => {
    const at = Date.parse(r.ranAt);
    return Number.isFinite(at) && at >= since;
  });

  if (fresh.length === 0) {
    log.info(`試行: 直近 ${WINDOW_MIN} 分のレポートが無いので通知しません`);
    return;
  }

  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(await readFile(resolve(DATA_DIR, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    // repo が読めなくても通知は出す（タップ先がスコープ直下になるだけ）
  }

  const head = fresh[0]!;
  /*
   * タップ先はサイトの入口ではなく、そのレポートが付いた日のダイジェストにする。
   * 複数件あるときは最新のもの側へ。「通知が来たので開いたが、どのカードの話か
   * 分からない」が起きると、この機能は一度で飽きられる。
   */
  const base = siteUrl(manifest?.repo);
  const url = base ? `${base}#/today/${head.digestDate}` : null;

  await sendPushToAll({
    title: (fresh.length === 1
      ? `試した結果: ${head.title}`
      : `試した結果が ${fresh.length} 件`
    ).slice(0, 120),
    body: (fresh.length === 1 ? head.headline : fresh.map((r) => r.title).join(' / ')).slice(0, 200),
    url,
    // 日次の通知と別の tag にする。同じにすると朝の通知が置き換わって消える
    tag: 'trial-report',
    ttlSeconds: 12 * 3600,
  });
}

await main();
