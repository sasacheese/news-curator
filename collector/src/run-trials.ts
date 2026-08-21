import { saveTrialReport } from './store.js';
import { claimRequests, finishRequest, resolveTarget, runTrial } from './trials.js';
import { log } from './util.js';

/**
 * 溜まっている「試させる」依頼を処理する。ワークフローから定期的に呼ばれる。
 *
 * 依頼が無ければ何もせず終わる（cron の空振りが大半になる前提の作り）。
 * 依頼があっても、1 回の上限と 1 日の上限で費用を頭打ちにする——ここが唯一の
 * 費用の門番なので、上限は環境変数で下げられるようにしてある。
 *
 * 通知はここでは送らない（notify-trials.ts の仕事）。レポートは Pages に
 * デプロイされてから初めて画面に出るので、先に通知すると、タップした先に
 * まだ結果が無い——朝のダイジェストで通知をデプロイ後に送っているのと同じ理由。
 */

const MAX_PER_RUN = Number(process.env.TRIAL_MAX_PER_RUN) || 2;
const MAX_PER_DAY = Number(process.env.TRIAL_MAX_PER_DAY) || 4;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.info('ANTHROPIC_API_KEY が無いため、試行はスキップします');
    return;
  }

  const requests = await claimRequests(MAX_PER_RUN, MAX_PER_DAY);
  if (requests === null) {
    log.info('Firebase の設定が無いため、試行はスキップします');
    return;
  }
  if (requests.length === 0) {
    log.info('試行: 順番待ちの依頼はありません');
    return;
  }
  log.info(`試行: ${requests.length} 件の依頼を処理します`);

  let done = 0;

  for (const req of requests) {
    const target = await resolveTarget(req);
    if (!target) {
      // 掲載記事に無い依頼（外から作られたもの、消えた日付）はここで終わる
      await finishRequest(req.key, 'failed', 'この記事は試す対象になっていません');
      continue;
    }

    try {
      const report = await runTrial(req, target);
      await saveTrialReport(report);
      await finishRequest(req.key, 'done', report.headline);
      done++;
      const usd = report.cost?.estimatedUsd;
      log.info(
        `試行: 完了 ${report.verdict} / ${report.seconds} 秒 / ` +
          `概算 ${usd == null ? '不明' : `$${usd.toFixed(2)}`} / ${report.title}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishRequest(req.key, 'failed', message);
      log.warn(`試行: 失敗 ${req.title}: ${message}`);
    }
  }

  log.info(`試行: ${done} 件のレポートを書きました`);
}

await main();
