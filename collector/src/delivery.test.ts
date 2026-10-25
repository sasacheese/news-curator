import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideDelivery, resolveDelivery, type DeliveryInput } from './delivery.js';

/** 2026-10-26 07:07 JST */
const AT_0707 = new Date('2026-10-25T22:07:00Z');
/** 2026-10-26 07:00 JST ちょうど。窓の終端 */
const AT_0700 = new Date('2026-10-25T22:00:00Z');
/** 2026-10-26 06:59 JST */
const AT_0659 = new Date('2026-10-25T21:59:00Z');
/** 2026-10-26 11:17 JST。予備 cron の時刻 */
const AT_1117 = new Date('2026-10-26T02:17:00Z');

function input(over: Partial<DeliveryInput> & Pick<DeliveryInput, 'event' | 'digestOnMain'>): DeliveryInput {
  return { now: AT_0707, ...over };
}

describe('decideDelivery', () => {
  it('07:07 JST でファイルが無ければ収集し、デプロイと通知まで進む', () => {
    const d = decideDelivery(input({ event: 'schedule', digestOnMain: false }));
    assert.equal(d.action, 'collect');
    assert.equal(d.date, '2026-10-26');
    assert.equal(d.deploy, true);
    assert.equal(d.notify, true);
    assert.equal(d.fatal, false);
  });

  it('07:00 ちょうどは当日の窓が閉じているので収集する', () => {
    const d = decideDelivery(input({ now: AT_0700, event: 'schedule', digestOnMain: false }));
    assert.equal(d.date, '2026-10-26');
    assert.equal(d.action, 'collect');
  });

  it('06:59 JST の定時は前日分で、当日の開いた窓には入らない', () => {
    const d = decideDelivery(input({ now: AT_0659, event: 'schedule', digestOnMain: false }));
    assert.equal(d.date, '2026-10-25');
    assert.equal(d.action, 'collect');
  });

  it('06:59 に当日を明示しても、窓が開いているので出さない', () => {
    const d = decideDelivery(
      input({ now: AT_0659, event: 'repository_dispatch', explicitDate: '2026-10-26', digestOnMain: false, force: true }),
    );
    assert.equal(d.action, 'skip');
    assert.equal(d.date, '2026-10-26');
    assert.equal(d.deploy, false);
    assert.equal(d.notify, false);
    assert.equal(d.fatal, false);
  });

  it('同じ日のファイルがあれば定時は収集もデプロイも通知もしない', () => {
    for (const now of [AT_0707, AT_1117]) {
      const d = decideDelivery(input({ now, event: 'schedule', digestOnMain: true }));
      assert.equal(d.date, '2026-10-26');
      assert.equal(d.action, 'skip');
      assert.equal(d.deploy, false);
      assert.equal(d.notify, false);
    }
  });

  it('11:17 の予備も 07:07 と同じ日を見て、窓は動かない', () => {
    const early = decideDelivery(input({ event: 'schedule', digestOnMain: false }));
    const late = decideDelivery(input({ now: AT_1117, event: 'schedule', digestOnMain: false }));
    assert.equal(early.date, late.date);
  });

  it('schedule に force が付いていても 2 回目は出さない', () => {
    const d = decideDelivery(input({ event: 'schedule', digestOnMain: true, force: true }));
    assert.equal(d.action, 'skip');
    assert.equal(d.notify, false);
  });

  it('workflow_dispatch の force は作り直して通知する', () => {
    const d = decideDelivery(input({ event: 'workflow_dispatch', digestOnMain: true, force: true }));
    assert.equal(d.action, 'collect');
    assert.equal(d.notify, true);
    assert.equal(d.deploy, true);
  });

  it('repository_dispatch の force も作り直す', () => {
    const d = decideDelivery(input({ event: 'repository_dispatch', digestOnMain: true, force: true }));
    assert.equal(d.action, 'collect');
    assert.equal(d.notify, true);
  });

  it('ファイルがある手動実行は、force が無ければ何もしない', () => {
    const d = decideDelivery(input({ event: 'workflow_dispatch', digestOnMain: true }));
    assert.equal(d.action, 'skip');
    assert.equal(d.notify, false);
    assert.equal(d.deploy, false);
  });

  it('skip_collect は再デプロイだけで、通知せず force より優先する', () => {
    const d = decideDelivery(
      input({ event: 'workflow_dispatch', digestOnMain: true, force: true, skipCollect: true }),
    );
    assert.equal(d.action, 'redeploy');
    assert.equal(d.deploy, true);
    assert.equal(d.notify, false);
  });

  it('repository_dispatch の skipCollect は無視する', () => {
    const d = decideDelivery(
      input({ event: 'repository_dispatch', digestOnMain: false, skipCollect: true }),
    );
    assert.equal(d.action, 'collect');
    assert.equal(d.notify, true);
  });

  it('skip_collect は 07:00 より前でも再デプロイできる', () => {
    const d = decideDelivery(
      input({ now: AT_0659, event: 'workflow_dispatch', digestOnMain: false, skipCollect: true }),
    );
    assert.equal(d.action, 'redeploy');
    assert.equal(d.notify, false);
  });

  it('日付が壊れていれば失敗扱いで、デプロイも通知もしない', () => {
    for (const explicitDate of ['2026/10/26', '2026-10-26; rm', '2026-13-40', 'next']) {
      const d = decideDelivery(input({ event: 'repository_dispatch', explicitDate, digestOnMain: false }));
      assert.equal(d.fatal, true);
      assert.equal(d.action, 'skip');
      assert.equal(d.deploy, false);
      assert.equal(d.notify, false);
      assert.equal(d.date, '');
    }
  });

  it('空の日付は時計から決める', () => {
    const d = decideDelivery(input({ event: 'schedule', explicitDate: '  ', digestOnMain: false }));
    assert.equal(d.date, '2026-10-26');
    assert.equal(d.fatal, false);
  });

  it('知らないイベントは失敗扱いにする', () => {
    const d = decideDelivery(input({ event: 'pull_request', digestOnMain: false }));
    assert.equal(d.fatal, true);
    assert.equal(d.notify, false);
  });
});

describe('resolveDelivery', () => {
  it('収集しない判定ではファイルを見ない', async () => {
    let calls = 0;
    const d = await resolveDelivery(
      { now: AT_0659, event: 'repository_dispatch', explicitDate: '2026-10-26', force: true },
      async () => {
        calls += 1;
        return false;
      },
    );
    assert.equal(d.action, 'skip');
    assert.equal(calls, 0);
  });

  it('ファイルがある定時は skip になり、通知しない', async () => {
    const d = await resolveDelivery({ now: AT_0707, event: 'schedule' }, async (date) => {
      assert.equal(date, '2026-10-26');
      return true;
    });
    assert.equal(d.action, 'skip');
    assert.equal(d.notify, false);
    assert.equal(d.deploy, false);
  });

  it('ファイルが無ければ collect のまま', async () => {
    const d = await resolveDelivery({ now: AT_1117, event: 'schedule' }, async () => false);
    assert.equal(d.action, 'collect');
    assert.equal(d.notify, true);
  });
});

describe('delivery CLI', () => {
  const cli = fileURLToPath(new URL('./delivery-cli.ts', import.meta.url));

  async function run(env: Record<string, string>, present: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'delivery-'));
    for (const date of present) {
      await writeFile(join(dir, `${date}.json`), '{}\n');
    }
    const output = join(dir, 'github-output.txt');
    const summary = join(dir, 'summary.md');
    const child = spawn(process.execPath, ['--import', 'tsx', cli], {
      env: {
        ...process.env,
        DELIVERY_DIGEST_DIR: dir,
        DELIVERY_NOW: AT_0707.toISOString(),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        CUTOFF_HOUR: '',
        ...env,
      },
    });
    let stdout = '';
    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    const status = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
    const outputs = await readFile(output, 'utf8');
    return { status, stdout, outputs };
  }

  it('ファイルが無ければ action=collect と notify=true を書く', async () => {
    const { status, outputs } = await run({ DELIVERY_EVENT: 'schedule' });
    assert.equal(status, 0);
    assert.match(outputs, /^action=collect$/m);
    assert.match(outputs, /^date=2026-10-26$/m);
    assert.match(outputs, /^notify=true$/m);
  });

  it('ファイルがあれば定時は skip で、通知フラグは false', async () => {
    const { status, outputs, stdout } = await run({ DELIVERY_EVENT: 'schedule', DELIVERY_FORCE: 'true' }, ['2026-10-26']);
    assert.equal(status, 0);
    assert.match(outputs, /^action=skip$/m);
    assert.match(outputs, /^notify=false$/m);
    assert.match(stdout, /既にある/);
  });

  it('手動の force=true はファイルがあっても collect', async () => {
    const { status, outputs } = await run(
      { DELIVERY_EVENT: 'workflow_dispatch', DELIVERY_FORCE: 'true' },
      ['2026-10-26'],
    );
    assert.equal(status, 0);
    assert.match(outputs, /^action=collect$/m);
    assert.match(outputs, /^notify=true$/m);
  });

  it('skip_collect は redeploy で通知しない', async () => {
    const { status, outputs } = await run(
      { DELIVERY_EVENT: 'workflow_dispatch', DELIVERY_SKIP_COLLECT: 'true', DELIVERY_FORCE: 'true' },
      ['2026-10-26'],
    );
    assert.equal(status, 0);
    assert.match(outputs, /^action=redeploy$/m);
    assert.match(outputs, /^notify=false$/m);
  });

  it('壊れた日付は終了コード 1 で、通知しない', async () => {
    const { status, outputs } = await run({ DELIVERY_EVENT: 'repository_dispatch', DELIVERY_DATE: 'tomorrow' });
    assert.equal(status, 1);
    assert.match(outputs, /^action=skip$/m);
    assert.match(outputs, /^notify=false$/m);
  });
});

describe('digest workflow', () => {
  it('正時を避け、2 回目はデプロイも通知も走らせない', async () => {
    const yaml = await readFile(new URL('../../.github/workflows/digest.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(yaml, /cron:\s*['"]0 /);
    for (const cron of ['7 22 * * *', '17 22 * * *', '27 22 * * *', '17 0 * * *', '17 2 * * *']) {
      const pattern = cron.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(yaml, new RegExp(`cron: '${pattern}'`));
    }
    assert.match(yaml, /repository_dispatch:\s*\n\s+types: \[digest\]/);
    assert.match(yaml, /cancel-in-progress:\s*false/);
    assert.match(yaml, /action == 'collect' \|\| needs\.collect\.outputs\.action == 'redeploy'/);
    assert.match(yaml, /send_push: \$\{\{ needs\.collect\.outputs\.action == 'collect' \}\}/);
    assert.match(yaml, /force:/);
  });
});
