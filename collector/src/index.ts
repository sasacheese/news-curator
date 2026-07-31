import { loadRuntimeConfig, loadSources, loadTopics } from './config.js';
import { enrichBodies, enrichHatenaCounts } from './enrich.js';
import { deepDive, getBackend, getUsageReport, logUsage, rankItems, resetUsage } from './llm.js';
import { dedupe, pickTopDiverse, preScore } from './prescore.js';
import { collectAll } from './sources.js';
import { loadSeenUrls, saveDigest } from './store.js';
import type { Digest, RankedItem, TopItem } from './types.js';
import { formatJst, log, mapLimit, resolveWindow } from './util.js';

interface Args {
  date?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date は YYYY-MM-DD 形式で指定してください: ${args.date}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = loadRuntimeConfig();
  const [topics, sources] = await Promise.all([loadTopics(), loadSources()]);

  const { date, start, end } = resolveWindow(new Date(), args.date, runtime.cutoffHour);
  const notes: string[] = [];
  resetUsage();

  log.info(`ダイジェスト日付 : ${date}`);
  log.info(`対象ウィンドウ   : ${formatJst(start)} 〜 ${formatJst(end)}`);
  log.info(`モデル           : rank=${runtime.rankModel} / summary=${runtime.summaryModel}`);

  const backend = await getBackend();
  if (!backend) {
    notes.push('LLM バックエンドが未設定のため、ルールベースのスコアで生成されています。');
    log.warn(
      'LLM バックエンドがありません（ルールベースで続行）。' +
        'ANTHROPIC_API_KEY を設定するか、ローカル開発なら LLM_BACKEND=claude-code を使ってください。',
    );
  } else {
    log.info(`バックエンド     : ${backend.name}${backend.metered ? '' : '（従量課金なし）'}`);
  }

  /* 1. 収集 --------------------------------------------------------- */
  log.step('1/6 収集');
  const collected = await collectAll(sources, { start, end });
  log.info(`合計 ${collected.length} 件`);

  if (collected.length === 0) {
    throw new Error('1 件も収集できませんでした。ネットワークかソース設定を確認してください。');
  }

  /* 2. 重複排除 ----------------------------------------------------- */
  log.step('2/6 重複排除');
  const seenUrls = await loadSeenUrls();
  log.info(`過去に掲載済み: ${seenUrls.size} URL`);
  const unique = dedupe(collected, seenUrls);
  log.info(`重複排除後 ${unique.length} 件（-${collected.length - unique.length}）`);

  /* 3. 事前スコアリング --------------------------------------------- */
  log.step('3/6 事前スコアリング');
  const withHatena = await enrichHatenaCounts(unique);
  const preScored = preScore(withHatena, topics).sort((a, b) => b.preScore - a.preScore);
  const candidates = preScored.slice(0, runtime.rankCandidates);
  log.info(
    `LLM 採点対象 ${candidates.length} 件（最高 ${(candidates[0]?.preScore ?? 0).toFixed(2)} / 最低 ${(candidates.at(-1)?.preScore ?? 0).toFixed(2)}）`,
  );

  /* 4. LLM ランキング ----------------------------------------------- */
  log.step('4/6 LLM ランキング');
  const ranked = (await rankItems(candidates, topics, runtime)).sort((a, b) => b.score - a.score);
  for (const item of ranked.slice(0, 8)) {
    log.info(`  ${String(item.score).padStart(3)} | ${item.sourceLabel} | ${item.title.slice(0, 60)}`);
  }

  /* 5. 深掘り要約 --------------------------------------------------- */
  log.step('5/6 深掘り要約');
  const topCandidates = pickTopDiverse(ranked, runtime.topN);
  const enriched = await enrichBodies(topCandidates, runtime.bodyCharLimit);
  const enrichedById = new Map(enriched.map((i) => [i.id, i]));

  const top: TopItem[] = await mapLimit(topCandidates, 3, async (item, i) => {
    const withBody = { ...item, ...(enrichedById.get(item.id) ?? {}) } as RankedItem;
    const deep = await deepDive(withBody, topics, runtime);
    log.info(`  #${i + 1} ${deep.headline}`);
    return { ...withBody, rank: i + 1, deep };
  });

  const topIds = new Set(top.map((t) => t.id));
  const others = ranked.filter((item) => !topIds.has(item.id)).slice(0, runtime.otherN);

  /* 6. 保存 --------------------------------------------------------- */
  log.step('6/6 保存');
  const bySource: Record<string, number> = {};
  for (const item of collected) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  }

  const digest: Digest = {
    date,
    generatedAt: new Date().toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
    top,
    others,
    stats: {
      collected: collected.length,
      afterDedupe: unique.length,
      afterPreScore: candidates.length,
      ranked: ranked.length,
      bySource,
      estimatedReadMinutes:
        top.reduce((sum, t) => sum + t.deep.readingMinutes, 0) + Math.ceil(others.length * 0.4),
    },
    topics: topics.topics.map((t) => t.name),
    models: { rank: runtime.rankModel, summary: runtime.summaryModel },
    usage: getUsageReport(),
    notes,
  };

  log.step('使用量');
  logUsage();

  if (args.dryRun) {
    log.info('--dry-run のため保存しません');
    console.log(JSON.stringify(digest, null, 2).slice(0, 4000));
    return;
  }

  await saveDigest(digest);
  log.info(
    `\n✔ 完了: ベスト${top.length}件 + その他${others.length}件 / 想定 ${digest.stats.estimatedReadMinutes} 分`,
  );
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
