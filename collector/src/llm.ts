import type { LlmBackend } from './backend.js';
import { selectBackend } from './backend.js';
import { CATEGORIES } from './categories.js';
import type { RuntimeConfig } from './config.js';
import {
  DeepDiveSchema,
  DescribeResultSchema,
  ScoreResultSchema,
  type DescribeResult,
} from './schemas.js';
import type {
  DeepDive,
  PreScoredItem,
  RankedItem,
  TopicsConfig,
  UsageReport,
  UsageStat,
} from './types.js';
import { log, mapLimit, truncate } from './util.js';

export { CATEGORIES };

let backend: LlmBackend | null | undefined;

export async function getBackend(): Promise<LlmBackend | null> {
  if (backend === undefined) backend = await selectBackend();
  return backend;
}

/* ------------------------------------------------------------------ *
 * 使用量の計測
 * ------------------------------------------------------------------ */

/**
 * 100万トークンあたりの単価（USD）。コスト表示は概算用。
 * 値下げや導入価格の終了で変わるので、判断に使う前に公式の価格表と突き合わせること。
 * Sonnet 5 の入出力は 2026-08-31 までの導入価格（通常は $3 / $15）。
 */
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
};

const usageByStage = new Map<string, UsageStat>();

export function resetUsage(): void {
  usageByStage.clear();
}

interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function recordUsage(
  stage: string,
  model: string,
  usage: NormalizedUsage,
  metered: boolean,
): void {
  const price = metered ? PRICING[model] : undefined;
  const prev = usageByStage.get(stage) ?? {
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
  };

  usageByStage.set(stage, {
    model,
    requests: prev.requests + 1,
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
    estimatedCostUsd:
      prev.estimatedCostUsd +
      (price
        ? (usage.inputTokens * price.input +
            usage.outputTokens * price.output +
            usage.cacheReadTokens * price.cacheRead) /
          1_000_000
        : 0),
  });
}

export function getUsageReport(): UsageReport {
  const stages: Record<string, UsageStat> = {};
  let total = 0;
  for (const [stage, stat] of usageByStage) {
    stages[stage] = stat;
    total += stat.estimatedCostUsd;
  }
  return { stages, totalCostUsd: Math.round(total * 10_000) / 10_000 };
}

export function logUsage(): void {
  const report = getUsageReport();
  for (const [stage, s] of Object.entries(report.stages)) {
    log.info(
      `  ${stage.padEnd(10)} ${String(s.requests).padStart(2)}req ` +
        `in ${s.inputTokens.toLocaleString().padStart(8)} / out ${s.outputTokens.toLocaleString().padStart(7)} ` +
        `= $${s.estimatedCostUsd.toFixed(4)} (${s.model})`,
    );
  }
  log.info(`  ${'合計'.padEnd(9)} $${report.totalCostUsd.toFixed(4)}`);
}

/** バックエンドを呼んで使用量も記録する */
async function complete<T>(
  b: LlmBackend,
  opts: Parameters<LlmBackend['complete']>[0] & { schema: import('zod').ZodType<T> },
): Promise<T> {
  const res = await b.complete<T>(opts);
  recordUsage(opts.stage, opts.model, res.usage, b.metered);
  return res.value;
}

/* ------------------------------------------------------------------ *
 * 1) ランキング（2 段階）
 *
 * 以前は候補全件に対して、スコアと同時に oneLiner・keywords まで書かせていた。
 * だが実際に保存するのは上位十数件だけで、残りの文章は捨てていた。
 * 出力トークンは入力の 5 倍高いので、これが採点コストの大半を占めていた。
 *
 * そこで 1 段目はスコアだけ返させ（1 件 10 トークン程度）、
 * 2 段目で生き残った十数件にだけ文章を書かせる。
 * ------------------------------------------------------------------ */

function readerContext(topics: TopicsConfig): string {
  const topicList = topics.topics
    .map((t) => `- ${t.name}（重要度 ${t.weight}/5）: ${t.keywords.slice(0, 8).join(', ')}`)
    .join('\n');
  return `# 読者プロフィール\n${topics.profile}\n\n# 関心トピック\n${topicList}`;
}

function scoreSystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡された記事を、この読者にとっての「今日読む価値」で 0〜100 点に採点してください。

${readerContext(topics)}

# 採点基準
- 90-100: 読者が日常的に使う技術の重大な変更・新機能。今日知らないと損をするレベル。
- 70-89 : 関心トピックど真ん中で、実装や意思決定に直接影響する具体的な内容。
- 50-69 : 関心はあるが緊急度は低い。あとで読めばよい良記事。
- 30-49 : 隣接領域。読者の主戦場からは少し遠い。
- 0-29  : 無関係、入門記事の焼き直し、宣伝、ポエム、内容の薄いまとめ。

# 重要な判断ルール
- 一次情報（公式リリースノート、公式ブログ、仕様策定）は二次情報より高く評価する。
- 「〜してみた」「入門」「まとめ」系は、独自の検証や数値がない限り 40 点以下。
- 人気（いいね数・順位）は参考程度。読者の関心との一致を最優先する。
- 同じ話題の記事が複数あるときは、最も一次情報に近く情報量の多いものを高くする。
- 日本語・英語で有利不利をつけない。

# 出力
- 説明や理由は書かず、ref と score だけを返す。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。`;
}

function describeSystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
選抜済みの記事について、一覧に載せる要約とキーワードを書いてください。

${readerContext(topics)}

# 出力
- すべて日本語で書く。
- oneLiner は「何が起きたか」を主語述語のある1文で。「〜について」のような曖昧な書き方は禁止。
- reason はこの読者にとっての意味を40字以内で。一般論ではなく読者の状況に紐づける。
- keywords は後から検索するためのもの。製品名・API名・バージョン番号などの固有名詞を優先する。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。`;
}

function renderCandidate(item: PreScoredItem, ref: number, excerptChars: number): string {
  const excerpt = truncate((item.body || item.snippet).replace(/\s+/g, ' ').trim(), excerptChars);
  // 生の LGTM 数などは渡さない。プラットフォーム間で桁が違って比較できず、
  // モデルが数字の大きいソースに引きずられるため、正規化済みの順位だけを渡す。
  const popularity = `同ソース内で上位 ${Math.round((1 - item.popularityPercentile) * 100)}%`;

  return [
    `[${ref}] ${item.title}`,
    `  ソース: ${item.sourceLabel} / ${popularity}`,
    item.tags.length ? `  タグ: ${item.tags.slice(0, 8).join(', ')}` : null,
    item.matchedTopics.length ? `  事前マッチ: ${item.matchedTopics.join(', ')}` : null,
    `  抜粋: ${excerpt || '(本文なし)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** LLM を使わないときのフォールバック値 */
function ruleBasedFields(item: PreScoredItem, note: string) {
  return {
    oneLiner: truncate(item.snippet.replace(/\s+/g, ' ').trim(), 80) || item.title,
    reason: note,
    keywords: item.matchedTopics.slice(0, 5),
    category: 'その他',
  };
}

/** 1 段目: 候補全件にスコアだけ付ける */
async function scorePass(
  b: LlmBackend,
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<Map<string, number>> {
  const batches: PreScoredItem[][] = [];
  for (let i = 0; i < items.length; i += cfg.rankBatchSize) {
    batches.push(items.slice(i, i + cfg.rankBatchSize));
  }

  const system = scoreSystemPrompt(topics);
  const scores = new Map<string, number>();

  await mapLimit(batches, 3, async (batch, batchIndex) => {
    const offset = batchIndex * cfg.rankBatchSize;
    const body = batch.map((item, i) => renderCandidate(item, offset + i, 500)).join('\n\n');

    try {
      const parsed = await complete(b, {
        stage: 'score',
        model: cfg.rankModel,
        maxTokens: 4000,
        system,
        prompt: `以下 ${batch.length} 件を採点してください。\n\n${body}`,
        schema: ScoreResultSchema,
      });
      for (const r of parsed.items ?? []) {
        const item = items[r.ref];
        if (item) scores.set(item.id, Math.max(0, Math.min(100, Math.round(r.score))));
      }
    } catch (err) {
      log.warn(`採点 batch ${batchIndex}: ${err instanceof Error ? err.message : err}`);
    }
  });

  return scores;
}

/** 2 段目: 実際に保存する分だけ文章化する */
async function describePass(
  b: LlmBackend,
  shortlist: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<Map<string, DescribeResult['items'][number]>> {
  const described = new Map<string, DescribeResult['items'][number]>();
  if (shortlist.length === 0) return described;

  const body = shortlist.map((item, i) => renderCandidate(item, i, 700)).join('\n\n');

  try {
    const parsed = await complete(b, {
      stage: 'describe',
      model: cfg.rankModel,
      maxTokens: 8000,
      system: describeSystemPrompt(topics),
      prompt: `以下 ${shortlist.length} 件を要約してください。\n\n${body}`,
      schema: DescribeResultSchema,
    });
    for (const r of parsed.items ?? []) {
      const item = shortlist[r.ref];
      if (item) described.set(item.id, r);
    }
  } catch (err) {
    log.warn(`要約: ${err instanceof Error ? err.message : err}`);
  }

  return described;
}

export async function rankItems(
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<RankedItem[]> {
  const b = await getBackend();
  if (!b) {
    log.warn('LLM バックエンドが無いためルールベースのスコアにフォールバックします');
    return items.map((item) => ({
      ...item,
      score: Math.round(item.preScore * 100),
      ...ruleBasedFields(item, '事前スコアのみ（LLM 未使用）'),
    }));
  }

  // 1 段目
  const scores = await scorePass(b, items, topics, cfg);
  log.info(`  スコアリング: ${scores.size}/${items.length} 件`);

  const scoreOf = (item: PreScoredItem) =>
    // 採点に失敗した分は事前スコアで代替する（控えめに）
    scores.get(item.id) ?? Math.round(item.preScore * 60);

  // 2 段目に回すのは、保存される分＋多様性確保のための余裕
  const shortlist = [...items]
    .sort((a, b2) => scoreOf(b2) - scoreOf(a))
    .slice(0, cfg.topN + cfg.otherN + 10);

  const described = await describePass(b, shortlist, topics, cfg);
  log.info(`  要約: ${described.size}/${shortlist.length} 件`);

  return items.map((item) => {
    const r = described.get(item.id);
    const score = scoreOf(item);
    if (!r) {
      return { ...item, score, ...ruleBasedFields(item, scores.has(item.id) ? '' : '採点失敗') };
    }
    return {
      ...item,
      score,
      oneLiner: r.oneLiner?.trim() || item.title,
      reason: r.reason?.trim() ?? '',
      keywords: (r.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
      category: CATEGORIES.includes(r.category) ? r.category : 'その他',
    };
  });
}

/* ------------------------------------------------------------------ *
 * 2) 深掘り要約（高性能モデル）
 * ------------------------------------------------------------------ */

function deepSystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
1本の記事を読み込み、「朝の30分で要点を掴んで、必要なら今日すぐ試せる」カードに変換してください。

# 読者プロフィール
${topics.profile}

# 執筆ルール
- すべて日本語。ただし API 名・オプション名・コマンドは原文のまま正確に書く。
- 記事に書かれていないことを推測で書かない。情報が無い項目は空配列にするか、その旨を明記する。
- 「〜が発表されました」で終わらせない。読者の手元のコードが具体的にどう変わるかまで踏み込む。
- howToTry は実際に打てるコマンド・書けるコードのレベルまで具体化する。「試してみましょう」は禁止。
- バージョン番号、フラグ名、デフォルト値の変更は省略せず正確に書く。
- 破壊的変更や移行が必要な点があれば、必ず whatChanges か caveats に入れる。
- code は、読者がコピペして動かし始められる最小の断片にする。記事に該当するものが無ければ null。
- 冗長な前置き・一般論・「重要です」といった中身のない強調は書かない。

# prerequisites（前提知識）の書き方

まず、次のことを頭の中でやってから書き始めること。

**この記事を、有能だが専門分野が違うエンジニアが読んでいる場面を想像する。**
（たとえばこの記事がフロントエンドの話なら、普段はバックエンドや機械学習をやっている人。
低レイヤの話なら、普段は業務Webアプリを書いている人。）
その人が記事を頭から読んでいったときに、**どの一文で手が止まるか**を具体的に洗い出す。
手が止まる典型は次のようなところ:

- 説明なしに出てくる固有名詞・略語（ツール名、仕様名、内部用語）
- 「もちろん〜なので」「当然〜だから」と、前提を共有している体で飛ばされている推論
- その分野では常識だが外から見ると理由がわからない慣習・制約
- 数値や挙動の変化が「すごい」とされているが、比較対象を知らないと凄さがわからない箇所
- 記事が解決している問題そのものが、その問題に遭遇したことがないと実感できない場合

そのうえで、**手が止まる箇所ごとに 1 項目**書く。

- stumblingPoint には、記事のどの記述で詰まるかを、記事中の語や一文を引いて具体的に書く。
  「〜という前提知識が必要」のような一般論ではなく、「記事は〜と書いているが、
  〜を知らないと〜が読み取れない」という形にする。
- explanation は、その詰まりが解消される説明を書く。用語の辞書的定義で終わらせない。
  「それが無いと何が困るのか」「この記事の文脈では何を意味するのか」まで踏み込む。
  必要なら、読者が既に知っている別分野の概念に例える。
- 読者プロフィールに書かれている技術は既知として扱い、説明しない。
  React を使う読者に「React とは」を書かない。それは詰まりどころではない。
- 記事本文が丁寧に説明している内容を繰り返さない。記事が省略している前提だけを埋める。
- 記事を最後まで読んでも詰まる箇所が無いなら、空配列でよい。埋めるために水増ししない。

# visual（図）の選び方
- comparison / flow / metrics のうち、記事の中身に最も合うものを1つだけ選ぶ。
- 記事の主題が「変更」なら comparison、「手順・仕組み」なら flow、「性能改善」なら metrics。
- metrics は記事に実際の数値が書かれている場合のみ。数値を推測で作らない。
- どれも当てはまらない、または図にしても情報が増えないなら null にする。無理に図を作らない。
- 図は本文の要約ではなく、文章では伝わりにくい構造（対比・順序・量）を担当させる。`;
}

export async function deepDive(
  item: RankedItem,
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<DeepDive> {
  const b = await getBackend();
  if (!b) return fallbackDeepDive(item);

  const meta = [
    `タイトル: ${item.title}`,
    `URL: ${item.url}`,
    `ソース: ${item.sourceLabel}`,
    `公開: ${item.publishedAt}`,
    item.tags.length ? `タグ: ${item.tags.join(', ')}` : null,
    item.matchedTopics.length ? `関連トピック: ${item.matchedTopics.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const content = truncate(item.body || item.snippet, cfg.bodyCharLimit);

  try {
    const parsed = await complete(b, {
      stage: 'deep',
      model: cfg.summaryModel,
      maxTokens: 12_000,
      effort: cfg.summaryEffort,
      system: deepSystemPrompt(topics),
      prompt: `${meta}\n\n--- 本文ここから ---\n${content}\n--- 本文ここまで ---`,
      schema: DeepDiveSchema,
    });

    return {
      headline: parsed.headline?.trim() || item.oneLiner,
      summary: parsed.summary?.trim() || item.oneLiner,
      prerequisites: (parsed.prerequisites ?? [])
        .filter((p) => p?.term && p?.explanation)
        .map((p) => ({ ...p, stumblingPoint: p.stumblingPoint ?? '' })),
      visual: normalizeVisual(parsed.visual as DeepDive['visual']),
      whatYouCanDo: parsed.whatYouCanDo ?? [],
      whatChanges: parsed.whatChanges ?? [],
      howToTry: parsed.howToTry ?? [],
      code: parsed.code ?? null,
      whyItMatters: parsed.whyItMatters?.trim() ?? '',
      caveats: parsed.caveats ?? [],
      relatedLinks: (parsed.relatedLinks ?? []).filter((l) => l?.url?.startsWith('http')),
      readingMinutes: Number.isFinite(parsed.readingMinutes)
        ? Math.max(1, Math.min(30, Math.round(parsed.readingMinutes)))
        : 5,
    };
  } catch (err) {
    log.warn(`深掘り失敗 (${item.title}): ${err instanceof Error ? err.message : err}`);
    return fallbackDeepDive(item);
  }
}

/**
 * 図は空でも成立するので、中身が足りないバリアントは丸ごと落とす。
 * 半端な図を出すより、図が無いほうが読みやすい。
 */
function normalizeVisual(visual: DeepDive['visual']): DeepDive['visual'] {
  if (!visual || typeof visual !== 'object') return null;

  switch (visual.type) {
    case 'comparison': {
      const rows = (visual.rows ?? []).filter((r) => r?.aspect && (r.before || r.after));
      if (rows.length < 2) return null;
      return { ...visual, rows };
    }
    case 'flow': {
      const steps = (visual.steps ?? []).filter((s) => s?.label);
      if (steps.length < 2) return null;
      return { ...visual, steps };
    }
    case 'metrics': {
      const items = (visual.items ?? []).filter((i) => i?.label && i?.value);
      if (items.length === 0) return null;
      return { ...visual, items };
    }
    default:
      return null;
  }
}

function fallbackDeepDive(item: RankedItem): DeepDive {
  return {
    headline: item.oneLiner,
    summary: truncate((item.body || item.snippet).replace(/\s+/g, ' ').trim(), 500),
    prerequisites: [],
    visual: null,
    whatYouCanDo: [],
    whatChanges: [],
    howToTry: ['元記事を開いて確認してください。'],
    code: null,
    whyItMatters: item.reason,
    caveats: ['LLM による要約に失敗したため、抜粋のみ表示しています。'],
    relatedLinks: [],
    readingMinutes: 5,
  };
}
