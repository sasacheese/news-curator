import { readFile, writeFile } from 'node:fs/promises';
import { collectCommunity } from './community.js';
import { loadCommunity, loadRadar, loadRuntimeConfig, loadSources, loadTopics } from './config.js';
import { enrichHatenaCounts, enrichTopItems } from './enrich.js';
import { applyFeedbackToTopics, loadFeedbackSignal, renderFeedbackNote } from './feedback.js';
import {
  deepDive,
  forecastOutlook,
  getBackend,
  getUsageReport,
  logUsage,
  rankItems,
  resetUsage,
  summarizeDigest,
} from './llm.js';
import { selectLaneCandidates } from './lanes.js';
import type { SlotRule } from './prescore.js';
import { dedupe, pickByLane, pickTopDiverse, preScore } from './prescore.js';
import { MENTION_WINDOW_DAYS, collectRadar } from './radar.js';
import { collectReleaseCandidates, extractReleases, sortReleases } from './releases.js';
import { collectAdvisories } from './advisories.js';
import { collectAll } from './sources.js';
import {
  loadPreviousCommunityIds,
  loadPreviousRadarIds,
  loadRadarLedger,
  loadRecentIndexEntries,
  loadRecentSummaries,
  loadSeenUrls,
  loadTrendLedger,
  saveCommunityBoard,
  saveDigest,
  saveRadarBoard,
  saveTrendBoard,
  saveTrendLedger,
  toIndexEntries,
} from './store.js';
import {
  LEDGER_DAYS,
  assignPublished,
  buildBoard,
  buildVocabulary,
  collectUnplaced,
  countDay,
  labelsForLedger,
  mergeLedger,
  trimLedger,
} from './trends.js';
import type {
  CommunityBoard,
  CommunityItem,
  Digest,
  Lane,
  RadarBoard,
  RadarLedgerEntry,
  RankedItem,
  RawItem,
  ReleaseItem,
  TopItem,
} from './types.js';
import { buildTryPrompt, identityFromUrl, otherQuestions } from './try-prompt.js';
import { COMMUNITY_ACTIONS, LANES, LANE_LABELS } from './types.js';
import { formatJst, log, mapLimit, normalizeUrl, resolveWindow, safe } from './util.js';

interface Args {
  date?: string;
  dryRun: boolean;
  /** data/ を触らずに指定パスへ書き出す。モデル比較で使う */
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
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

  /*
   * コミュニティ情報は記事のパイプラインに依存しない（開催日と締切で引くので、
   * 収集した記事も重複排除も使わない）。ここで投げておいて、後で受け取る。
   */
  const communityTask = safe(
    'community',
    async () => {
      const cfg = await loadCommunity();
      const previousIds = await loadPreviousCommunityIds();
      return await collectCommunity(cfg, topics, previousIds, backend, runtime);
    },
    { items: [] as CommunityItem[], degraded: false },
  );

  /* 1. 収集 --------------------------------------------------------- */
  log.step('1/7 収集');
  /**
   * COLLECT_CACHE を指定すると収集結果を再利用する。
   * モデルを比べるときに入力が違うと比較にならないため
   * （トレンド系のソースは実行のたびに中身が変わる）。実験用で、本番では使わない。
   */
  const collected = await withCollectCache(process.env.COLLECT_CACHE, () =>
    collectAll(sources, { start, end }),
  );
  log.info(`合計 ${collected.length} 件`);

  if (collected.length === 0) {
    throw new Error('1 件も収集できませんでした。ネットワークかソース設定を確認してください。');
  }

  /* 2. 重複排除 ----------------------------------------------------- */
  log.step('2/7 重複排除');
  /*
   * 同じ日を作り直すときは、その日ぶんを「掲載済み」に数えない。
   * 数えると自分の前回の出力を除外してしまい、余りものだけの盤面になる。
   */
  const seenUrls = await loadSeenUrls(90, date);
  log.info(`過去に掲載済み: ${seenUrls.size} URL（${date} ぶんを除く）`);
  const unique = dedupe(collected, seenUrls);
  log.info(`重複排除後 ${unique.length} 件（-${collected.length - unique.length}）`);

  /*
   * 発掘。記事のパイプラインに依存しない。
   *
   * 母集団は過去 90 日のインデックスの keywords と当日の GitHub リポジトリだけで、
   * ランキングの結果は使わない——ここで欲しいのは「その道具が今どういう状態に
   * あるか」で、それは今日どの記事が上位に来たかとは無関係だからだ。
   *
   * 外部 API の待ちが長い（1 語あたり最大 4 リクエスト × 24 語）ので、
   * ここで投げて採点・深掘りと並行させ、保存の直前に受け取る。
   */
  const radarTask = safe(
    'radar',
    async () => {
      const cfg = await loadRadar();
      if (!cfg.enabled) {
        log.info('発掘は config/radar.json で無効になっています');
        return null;
      }
      const [entries, ledger, previousIds] = await Promise.all([
        loadRecentIndexEntries(date, MENTION_WINDOW_DAYS),
        loadRadarLedger(),
        loadPreviousRadarIds(),
      ]);
      return await collectRadar(cfg, runtime, topics, backend, {
        entries,
        items: unique,
        ledger,
        previousIds,
        date,
        now: new Date(),
      });
    },
    null as { board: RadarBoard; ledger: RadarLedgerEntry[] } | null,
  );

  /* 2.5 リリース情報 ------------------------------------------------- */
  // ランキングとは別枠。順位をつけず全件出す。
  log.step('リリース情報');
  const releaseCandidates = collectReleaseCandidates(unique, { start, end });
  log.info(`  候補 ${releaseCandidates.length} 件`);
  /*
   * 脆弱性は別の入口から取る。リリースノートには載らない（実測 27 件中 0 件）ので、
   * 監視対象を増やしても拾えない。LLM は通さない——GitHub が付けた深刻度と
   * 修正版のほうが、要約より確かで有用。
   */
  const [described, advisories] = await Promise.all([
    extractReleases(backend, releaseCandidates, topics, runtime),
    safe('advisories', () =>
      collectAdvisories(sources.advisories, sources.githubReleases.repos, { start, end },
        process.env.GITHUB_TOKEN),
      [] as ReleaseItem[],
    ),
  ]);
  const releases = sortReleases([...described, ...advisories]);
  /**
   * URL で持つ。同一製品でまとめられた項目は代表の折りたたみに入って
   * id が releases から消えるので、id だけで突き合わせると一覧に再登場してしまう。
   */
  const releaseUrls = new Set(
    releases.flatMap((r) => [r.url, ...r.alsoReleased.map((a) => a.url)]).map(normalizeUrl),
  );

  /* コミュニティ情報 -------------------------------------------------- */
  /*
   * イベント・登壇募集・もくもく会。順位を付けず、開催日と締切で並べる。
   *
   * ダイジェストには入れず data/community.json に単独で保存する。流動性が高く
   * 「その日の記録」として残す意味が無いためで、日次に埋めると同じ 12 件が毎日
   * コミットされ、過去日を開いたときに終わったイベントが並ぶ。画面も
   * 「今日」ではなく専用タブに出す。
   *
   * 記事の重複排除にも検索インデックスにも通さない。
   */
  log.step('コミュニティ');
  const community = await communityTask;
  const communityNotes: string[] = [];
  if (community.degraded) {
    communityNotes.push(
      'connpass の API キーが未設定のため、Doorkeeper と confs.tech だけで集めています' +
        '（もくもく会はほとんど拾えません）。',
    );
    log.warn('  CONNPASS_API_KEY が未設定です。日本語のイベントの母集団が大きく欠けます。');
  }

  /* 読者フィードバック ------------------------------------------------ */
  /*
   * 直近 2 週間の Good/Bad をトピック重みへ反映する。Firebase 未設定なら
   * signal は null になり、以降は今までと完全に同じ動作になる。
   */
  const feedbackSignal = await safe('feedback', () => loadFeedbackSignal(), null);
  const effectiveTopics = feedbackSignal ? applyFeedbackToTopics(topics, feedbackSignal) : topics;
  const feedbackNote = feedbackSignal ? renderFeedbackNote(feedbackSignal) : null;
  if (feedbackSignal) log.info(`  フィードバック ${feedbackSignal.totalVotes} 件を反映`);

  /* 3. 事前スコアリングとレーン振り分け ------------------------------ */
  log.step('3/7 事前スコアリング');
  const withHatena = await enrichHatenaCounts(unique);
  const preScored = preScore(withHatena, effectiveTopics).sort((a, b) => b.preScore - a.preScore);

  /*
   * レーンごとに別の信号で候補を絞る。
   *
   * 以前はここで preScore 上位 150 件に切っていたが、preScore の主項は
   * トピックキーワードの一致なので、それは「読者が既に知っている領域か」で
   * 絞っていたことになる。大きな話題も新しい道具も、その網には掛からない。
   * 絞り込みは preScored 全件を母集団にして、目的ごとに行う。
   */
  const selection = selectLaneCandidates(
    preScored,
    runtime.laneCandidates,
    runtime.laneThresholds,
  );
  const candidates = LANES.flatMap((lane) => selection.candidates[lane]);
  log.info(
    `  振り分け: ${LANES.map((l) => `${LANE_LABELS[l]} ${selection.assigned[l]}`).join(' / ')}` +
      `（しきい値 know=${runtime.laneThresholds.know} talk=${runtime.laneThresholds.talk}）`,
  );
  log.info(
    `LLM 採点対象 ${candidates.length} 件: ` +
      LANES.map((l) => `${LANE_LABELS[l]} ${selection.candidates[l].length}`).join(' / '),
  );

  /* 4. LLM ランキング ----------------------------------------------- */
  log.step('4/7 LLM ランキング');
  /*
   * レーンをまたいだスコアの比較には意味が無い。know の 80 点は「規模」への、
   * talk の 80 点は「立場が割れるか」への答えで、別の問いへの答えだからだ。
   * 並べ替えは常にレーン内で行う。
   */
  const ranked = await rankItems(selection.candidates, effectiveTopics, runtime, feedbackNote);

  /*
   * 採点が 1 件も成立しなかった日を、画面から見えるようにする。
   *
   * LLM の呼び出しはリクエスト単位で例外を握りつぶすので、全滅しても実行は成功し、
   * ルールベースのスコアでダイジェストが組み上がってコミットまで通る。実際に
   * OpenAI がスキーマ名を弾いた日に、150 件すべてが「採点失敗」のまま公開された。
   * 落ちずに劣化する方針は変えないが、劣化したことは読み手に伝える。
   */
  if (backend) {
    const scoreRequests = Object.entries(getUsageReport().stages)
      .filter(([stage]) => stage.startsWith('score:'))
      .reduce((sum, [, s]) => sum + s.requests, 0);
    if (scoreRequests === 0) {
      const note =
        'LLM の採点が全件失敗したため、事前スコアだけで並べています。' +
        '読みどころと深掘りは生成されていません。';
      notes.push(note);
      log.error(`  ${note} 実行ログの警告を確認してください。`);
    }
  }
  const rankedByLane = (lane: Lane) =>
    ranked.filter((i) => i.lane === lane).sort((a, b) => b.score - a.score);
  for (const lane of LANES) {
    for (const item of rankedByLane(lane).slice(0, 3)) {
      log.info(
        `  [${LANE_LABELS[lane]}] ${String(item.score).padStart(3)} | ${item.sourceLabel} | ${item.title.slice(0, 50)}`,
      );
    }
  }

  /* 5. 深掘り要約 --------------------------------------------------- */
  log.step('5/7 深掘り要約');
  /**
   * ベスト N の枠。スコア順で埋めたあと、満たしていないものだけ下位と入れ替える。
   * 1 位は動かさないので、そのレーンの最重要は必ず残る。
   *
   * 枠ルールはレーンごとに変える。目的が違えば「確保したいもの」も違う。
   * - know: 一次情報。実測でベスト+その他の 15 件中 0〜1 件しか残らなかった。
   *   公式ブログを毎日 40 件拾っているのに二次情報が構造的に勝っていた。
   * - build: 触れる実体があるもの。「すごそう」だけで枠が埋まると、
   *   このレーンは目的を果たさない。payoff=apply とリポジトリ由来を実体とみなす。
   * - talk: 枠を確保しない。争点があるかどうかは採点で見ており、
   *   それ以上に「この性質のものを必ず入れる」と決められる軸が無い。
   */
  const primarySource: SlotRule<RankedItem> = {
    label: '一次情報',
    match: (i) => i.source === 'rss' || i.source === 'github_release' || i.source === 'changelog',
  };
  const durable: SlotRule<RankedItem> = {
    label: '長く効くもの',
    match: (i) => i.durability === 'foundational' || i.durability === 'durable',
  };
  const tangible: SlotRule<RankedItem> = {
    label: '今日試せるもの',
    match: (i) => i.payoff === 'apply' || i.source === 'github_repo',
  };
  const laneSlotRules: Record<Lane, SlotRule<RankedItem>[]> = {
    know: [primarySource, durable],
    build: [tangible, durable],
    talk: [],
  };

  const topCandidates = LANES.flatMap((lane) => {
    /*
     * スコア下限を先に掛ける。掛けないと、そのレーンに該当が乏しい日でも
     * 必ず topN 件が深掘りされる（全部 20 点の日でも上位 2 件が Sonnet に回る）。
     * 件数を埋めることより、薄い日は薄いまま出すことを優先する。
     */
    const pool = rankedByLane(lane).filter((i) => i.score >= runtime.minTopScore);
    const dropped = rankedByLane(lane).length - pool.length;
    const picked = pickTopDiverse(pool, runtime.topN, laneSlotRules[lane]);
    if (picked.length < runtime.topN) {
      log.warn(
        `  ${LANE_LABELS[lane]}のベストは ${picked.length}/${runtime.topN} 件` +
          `（${runtime.minTopScore} 点未満を ${dropped} 件除外）`,
      );
    }
    for (const rule of laneSlotRules[lane]) {
      if (picked.length > 0 && !picked.some(rule.match)) {
        log.warn(
          `  ${LANE_LABELS[lane]}のベスト${runtime.topN}に「${rule.label}」の枠を確保できませんでした`,
        );
      }
    }
    log.info(`  ${LANE_LABELS[lane]}: ${picked.length} 件（候補 ${pool.length}）`);
    return picked;
  });
  const enriched = await enrichTopItems(topCandidates, runtime.bodyCharLimit);
  const enrichedById = new Map(enriched.items.map((i) => [i.id, i]));

  // rank はレーン内で 1 から振る（画面上も「知る のベスト」「作る のベスト」で分かれる）
  const rankOf = new Map<string, number>();
  for (const lane of LANES) {
    let r = 0;
    for (const c of topCandidates) {
      if (c.lane === lane) rankOf.set(c.id, ++r);
    }
  }

  const top: TopItem[] = await mapLimit(topCandidates, 3, async (item) => {
    const withBody = { ...item, ...(enrichedById.get(item.id) ?? {}) } as RankedItem;
    const deep = await deepDive(withBody, topics, runtime, enriched.bodyImages.get(item.id));
    log.info(`  [${LANE_LABELS[item.lane]}] #${rankOf.get(item.id)} ${item.oneLiner}`);
    return { ...withBody, rank: rankOf.get(item.id) ?? 1, deep };
  });

  // リリース情報は別枠で全件出しているので、一覧には重複させない
  const topIds = new Set(top.map((t) => t.id));
  const remaining = LANES.flatMap((lane) =>
    rankedByLane(lane).filter(
      (item) =>
        !topIds.has(item.id) &&
        !releaseUrls.has(normalizeUrl(item.url)) &&
        item.score >= runtime.minOtherScore,
    ),
  );
  const byLane = pickByLane(remaining, runtime.otherN);
  /*
   * 画面はレーンで分けて出すので、保存もレーン順にまとめておく。
   *
   * ここで試すプロンプトも付ける。URL が GitHub のリポジトリや npm を指しているものだけに
   * 付き、記事（Qiita / Zenn / はてな / HN）には付かない——身元が取れないので
   * 正しく null になる。
   */
  const others = LANES.flatMap((lane) => byLane[lane].sort((a, b) => b.score - a.score)).map(
    (item) => ({
      ...item,
      tryPrompt: buildTryPrompt(identityFromUrl(item.url), {
        goal: `${item.title} を動かして、README の最初の出力まで到達する`,
        url: item.url,
        questions: otherQuestions(),
      }),
    }),
  );
  log.info(`  そのうち試すプロンプトを付けたもの: ${others.filter((o) => o.tryPrompt).length} 件`);
  log.info(
    `  その他の注目記事: ${LANES.map((l) => `${LANE_LABELS[l]} ${byLane[l].length}`).join(' / ')}`,
  );

  // 選定は ranked 全体に届くので、要約対象の外から拾うことが原理的にありうる。
  // 起きたら気づけるようにしておく（黙って本文の切り出しが出るのが一番まずい）
  const undescribed = [...top, ...others].filter((i) => i.takeaways.length === 0);
  if (undescribed.length > 0) {
    log.warn(
      `  要約されていない項目が ${undescribed.length} 件選ばれました: ${undescribed
        .map((i) => i.title.slice(0, 30))
        .join(' / ')}`,
    );
  }

  /* 発掘 -------------------------------------------------------------- */
  /*
   * まだ日本で使われていない道具。「海外の熱」と「国内の厚み」を別々に測って
   * 差が大きいものだけを出す。日次ダイジェストには入れず data/radar.json に持つ
   * （日ごとの記録として残す意味が無く、日次に埋めると同じ 10 件が毎日
   * コミットされる。コミュニティ盤面と同じ理由）。
   */
  log.step('発掘');
  const radar = await radarTask;
  if (radar) {
    for (const item of radar.board.items.slice(0, 5)) {
      log.info(`  [${item.verdict}] ${item.name} — ${item.evidence[0] ?? ''}`);
    }
  }

  /* 6. 冒頭サマリー --------------------------------------------------- */
  log.step('6/7 冒頭サマリー');
  const summary = await summarizeDigest(top, releases, others, topics, runtime);
  for (const line of summary) log.info(`  ${line}`);

  // 今日の点だけでは流れが見えないので、直近数日のサマリーを添えて見立てを書かせる
  const history = await safe('outlook-history', () => loadRecentSummaries(date, 7), []);
  const outlook = await forecastOutlook(summary, history, top, releases, others, topics, runtime);
  if (outlook) log.info(`  [この先] ${outlook}`);

  /* 7. 保存 --------------------------------------------------------- */
  log.step('7/7 保存');
  const bySource: Record<string, number> = {};
  for (const item of collected) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  }
  const laneCounts: Record<string, number> = {};
  for (const item of [...top, ...others]) {
    laneCounts[item.lane] = (laneCounts[item.lane] ?? 0) + 1;
  }
  // 0 件の行動も残す。どの枠が薄いのか後から追えるようにするため
  const communityBoard: CommunityBoard = {
    updatedAt: new Date().toISOString(),
    date,
    items: community.items,
    byAction: Object.fromEntries(
      COMMUNITY_ACTIONS.map((a) => [a, community.items.filter((i) => i.action === a).length]),
    ),
    notes: communityNotes,
  };

  const digest: Digest = {
    date,
    generatedAt: new Date().toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
    summary,
    outlook,
    top,
    releases,
    others,
    stats: {
      collected: collected.length,
      afterDedupe: unique.length,
      afterPreScore: candidates.length,
      ranked: ranked.length,
      bySource,
      byLane: laneCounts,
      estimatedReadMinutes:
        top.reduce((sum, t) => sum + t.deep.readingMinutes, 0) + Math.ceil(others.length * 0.4),
    },
    topics: topics.topics.map((t) => t.name),
    models: { rank: runtime.rankModel, summary: runtime.summaryModel },
    usage: getUsageReport(),
    notes,
  };

  /* トレンド（話題台帳） --------------------------------------------- */
  /*
   * ダイジェストは差分刊行なので、昨日の 1 位は今日どこにも出ない。ここでは
   * 記事ではなく「話題」を単位に、日をまたいだ状態を持つ。LLM は通さないので
   * 追加費用はゼロ。落ちてもダイジェストは出す（safe で包む）。
   *
   * 数えるのは掲載した 30 件ではなく重複排除後の全件。掲載ぶんだけを母集団に
   * すると、その日に 10 本出ていた話題が 1 本にしか見えない。
   */
  log.step('トレンド');
  const trend = await safe(
    'trends',
    async () => {
      const [ledger, pastEntries] = await Promise.all([
        loadTrendLedger(date),
        loadRecentIndexEntries(date, LEDGER_DAYS),
      ]);
      const todayEntries = toIndexEntries(digest);
      const vocab = buildVocabulary(
        [...pastEntries, ...todayEntries].flatMap((e) => e.keywords ?? []),
        preScored,
      );
      const counted = countDay(date, preScored, vocab);
      const days = trimLedger(mergeLedger(ledger.days, counted.day));
      const publishedUrls = new Set(todayEntries.map((e) => normalizeUrl(e.url)));
      const board = buildBoard({
        date,
        updatedAt: new Date().toISOString(),
        days,
        labels: vocab.labels,
        variantsByTopic: counted.variantsByTopic,
        publishedByTopic: assignPublished(
          // 今日ぶんは index にまだ無いので、ここで足してから割り当てる
          [...todayEntries, ...pastEntries.filter((e) => e.date !== date)],
          vocab,
        ),
        unplacedByTopic: collectUnplaced(counted.itemsByTopic, publishedUrls, normalizeUrl),
      });
      const labels = labelsForLedger(days, vocab.labels, ledger.labels);
      log.info(
        `  語彙 ${vocab.labels.size} / 話題 ${Object.keys(counted.day.counts).length}` +
          ` / 台帳 ${days.length} 日`,
      );
      for (const topic of board.hot) {
        const lift = topic.lift == null ? '初出' : `平常比 ${topic.lift.toFixed(1)}`;
        log.info(`  [動いた] ${topic.name}（今日 ${topic.today} 本・${lift}）`);
      }
      return { board, days, labels };
    },
    null,
  );
  if (!trend) {
    log.warn('  トレンドの算出に失敗しました。盤面は前回のまま残ります。');
  }

  log.step('使用量');
  logUsage();

  if (args.dryRun) {
    log.info('--dry-run のため保存しません');
    console.log(
      JSON.stringify({ digest, community: communityBoard, radar: radar?.board }, null, 2).slice(
        0,
        4000,
      ),
    );
    return;
  }

  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
    log.info(`保存: ${args.out}（data/ は変更していません）`);
    logComparableSummary(digest);
    return;
  }

  await saveDigest(digest);
  // 盤面は日付を持たない別ファイル。ダイジェストが落ちた日でも単独で更新される
  await saveCommunityBoard(communityBoard);
  if (radar) await saveRadarBoard(radar.board, radar.ledger);
  if (trend) {
    await saveTrendLedger(trend.days, trend.labels);
    await saveTrendBoard(trend.board);
  }
  log.info(
    `\n✔ 完了: ベスト${top.length}件 + その他${others.length}件` +
      ` + コミュニティ${community.items.length}件` +
      ` + 発掘${radar?.board.items.length ?? 0}件 / 想定 ${digest.stats.estimatedReadMinutes} 分`,
  );
}

/** 収集結果をファイルに固定する。モデル比較で同じ入力を使うため */
async function withCollectCache(
  path: string | undefined,
  fetch: () => Promise<RawItem[]>,
): Promise<RawItem[]> {
  if (!path) return await fetch();
  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as RawItem[];
    log.info(`収集キャッシュを再利用: ${path}（${cached.length} 件）`);
    return cached;
  } catch {
    const fresh = await fetch();
    await writeFile(path, `${JSON.stringify(fresh)}\n`, 'utf8');
    log.info(`収集キャッシュを作成: ${path}`);
    return fresh;
  }
}

/** モデル比較のときに目で追う値をまとめて出す */
function logComparableSummary(digest: Digest): void {
  log.step('比較用サマリ');
  for (const [stage, s] of Object.entries(digest.usage.stages)) {
    log.info(
      `  ${stage.padEnd(9)} ${String(s.requests).padStart(2)}req ` +
        `in ${s.inputTokens.toLocaleString().padStart(8)} out ${s.outputTokens.toLocaleString().padStart(7)} ` +
        `$${s.estimatedCostUsd.toFixed(4)} ${(s.elapsedMs / 1000).toFixed(1)}s ${s.model}`,
    );
  }
  log.info(`  合計 $${digest.usage.totalCostUsd.toFixed(4)}`);
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
