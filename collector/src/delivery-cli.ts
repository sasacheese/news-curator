import { appendFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { resolveDelivery, type DeliveryDecision } from './delivery.js';

/**
 * ワークフローの収集ステップより前に呼び、GITHUB_OUTPUT へ action / date / notify を書く。
 *
 * 見るファイルは、ジョブ開始時に origin の先端へ合わせたあとの
 * data/digests/YYYY-MM-DD.json。ここが在れば、その日はもう出している。
 *
 * DELIVERY_NOW と DELIVERY_DIGEST_DIR はテストから時計とディレクトリを
 * 差し替えるためのもので、ワークフローは渡さない。
 */

function cutoffHour(): number {
  const raw = process.env.CUTOFF_HOUR;
  if (raw == null || raw.trim() === '') return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error(`CUTOFF_HOUR が 0 から 23 の整数ではない: ${raw}`);
  }
  return n;
}

function now(): Date {
  const raw = process.env.DELIVERY_NOW;
  if (raw == null || raw.trim() === '') return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error('DELIVERY_NOW を日時として解釈できない');
  return d;
}

function digestFile(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dir = process.env.DELIVERY_DIGEST_DIR?.trim() || resolve(DATA_DIR, 'digests');
  return resolve(dir, `${date}.json`);
}

function writeOutput(decision: DeliveryDecision): void {
  const notify = decision.notify ? 'true' : 'false';
  const lines = [`action=${decision.action}`, `date=${decision.date}`, `notify=${notify}`];
  console.log(`delivery action=${decision.action} date=${decision.date || '-'} notify=${notify}`);
  console.log(`delivery reason=${decision.reason}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${lines.join('\n')}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const deploy = decision.deploy ? 'する' : 'しない';
    const push = decision.notify ? 'する' : 'しない';
    appendFileSync(
      summary,
      [
        '### 配信判定',
        '',
        `- 結果: ${decision.action}`,
        `- 対象日: ${decision.date || '（なし）'}`,
        `- デプロイ: ${deploy}`,
        `- 通知: ${push}`,
        `- 理由: ${decision.reason}`,
        '',
      ].join('\n'),
    );
  }
}

async function main(): Promise<void> {
  let decision: DeliveryDecision;
  try {
    decision = await resolveDelivery(
      {
        now: now(),
        event: process.env.DELIVERY_EVENT ?? '',
        explicitDate: process.env.DELIVERY_DATE,
        force: process.env.DELIVERY_FORCE === 'true',
        skipCollect: process.env.DELIVERY_SKIP_COLLECT === 'true',
        cutoffHour: cutoffHour(),
      },
      async (date) => {
        const path = digestFile(date);
        if (!path) return false;
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  writeOutput(decision);
  if (decision.fatal) process.exit(1);
}

await main();
