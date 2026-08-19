import { loadRadar, loadRuntimeConfig, loadTopics } from './config.js';
import { getBackend, getUsageReport, logUsage, resetUsage } from './llm.js';
import { collectRadar } from './radar.js';
import {
  loadPreviousRadarIds,
  loadRadarLedger,
  loadRecentIndexEntries,
  saveRadarBoard,
} from './store.js';
import { jstDateString, log } from './util.js';

/* ------------------------------------------------------------------ *
 * 発掘だけを単独で回す。
 *
 * これが必要なのは、`domesticThin` の適正値を実データ抜きに決められないため。
 * 日次の収集ごと回すと 1 回に数分と Claude API の実費がかかるので、しきい値を
 * 1 つ動かして結果を見る、という調整ができない。発掘は記事のパイプラインに
 * 依存しない（母集団は過去のインデックスと当日の GitHub だけ）ので、単独で回せる。
 *
 *   npm run radar:dry                    # 保存せず結果だけ見る
 *   npm run radar:dry -- --budget=6      # 外部 API の呼び出しを抑える
 *   npm run radar:dry -- --thin=60       # しきい値を仮に変えて結果を比べる
 *   npm run radar:dry -- --save          # data/radar.json も書き換える
 *   npm run radar:dry -- --why=Oxlint    # ある語が落ちた理由を見る
 * ------------------------------------------------------------------ */

interface Args {
  budget?: number;
  thin?: number;
  known?: number;
  save: boolean;
  why?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { save: false };
  for (const a of argv) {
    if (a === '--save') args.save = true;
    else if (a.startsWith('--budget=')) args.budget = Number(a.slice('--budget='.length));
    else if (a.startsWith('--thin=')) args.thin = Number(a.slice('--thin='.length));
    else if (a.startsWith('--known=')) args.known = Number(a.slice('--known='.length));
    else if (a.startsWith('--why=')) args.why = a.slice('--why='.length);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = loadRuntimeConfig();
  const [topics, base] = await Promise.all([loadTopics(), loadRadar()]);
  resetUsage();

  const cfg = {
    ...base,
    ...(Number.isFinite(args.budget) ? { measureBudget: args.budget as number } : {}),
    ...(Number.isFinite(args.thin) ? { domesticThin: args.thin as number } : {}),
    ...(Number.isFinite(args.known) ? { domesticKnown: args.known as number } : {}),
  };
  log.info(
    `しきい値: thin=${cfg.domesticThin} known=${cfg.domesticKnown} / 計測予算 ${cfg.measureBudget} 語`,
  );

  const backend = await getBackend();
  if (!backend) {
    log.warn(
      'LLM バックエンドがありません。台帳に無い語の同定と紹介文の生成はされません' +
        '（既に台帳にある語の再計測と判定だけが走ります）。',
    );
  }

  const [entries, ledger, previousIds] = await Promise.all([
    loadRecentIndexEntries(90),
    loadRadarLedger(),
    loadPreviousRadarIds(),
  ]);

  const { board, ledger: next } = await collectRadar(cfg, runtime, topics, backend, {
    entries,
    items: [],
    ledger,
    previousIds,
    date: jstDateString(new Date()),
    now: new Date(),
  });

  log.step('盤面');
  for (const item of board.items) {
    console.log(`\n[${item.verdict}] ${item.name}${item.isNew ? '  NEW' : ''}  (${item.score} 点)`);
    console.log(`  ${item.what}`);
    console.log(`  紹介 : ${item.pitch || '(未生成)'}`);
    console.log(`  代わり: ${item.insteadOf.join(' / ') || '—'}`);
    console.log(`  一歩  : ${item.firstStep ?? '—'}`);
    console.log(`  注意  : ${item.caution ?? '—'}`);
    for (const e of item.evidence) console.log(`  ・${e}`);
  }
  if (board.items.length === 0) log.info('  該当なし');

  /*
   * 落ちた理由を出す。しきい値の調整では、出たものより
   * **出なかったものがなぜ出なかったか**のほうが手がかりになる。
   */
  log.step('計測済みで盤面に載らなかったもの');
  const rejected = next
    .filter((e) => e.measure && e.lastVerdict == null)
    .sort((a, b) => (a.lastReason ?? '').localeCompare(b.lastReason ?? ''));
  for (const e of rejected) {
    console.log(`  ${e.name.padEnd(26)} ${e.lastReason ?? '—'}`);
  }
  if (rejected.length === 0) log.info('  なし');

  if (args.why) {
    log.step(`「${args.why}」の台帳`);
    const hit = next.find((e) => e.name.toLowerCase().includes(args.why!.toLowerCase()));
    console.log(hit ? JSON.stringify(hit, null, 2) : '  台帳にありません');
  }

  log.step('台帳');
  log.info(
    `  ${next.length} 語（道具 ${next.filter((e) => e.resolved?.isTool).length} / ` +
      `道具でない ${next.filter((e) => e.resolved?.isTool === false).length} / ` +
      `未同定 ${next.filter((e) => !e.resolved).length}）`,
  );

  if (getUsageReport().totalCostUsd > 0 || Object.keys(getUsageReport().stages).length > 0) {
    log.step('使用量');
    logUsage();
  }

  if (args.save) {
    await saveRadarBoard(board, next);
  } else {
    log.info('\n--save を付けていないので data/ は変更していません');
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
