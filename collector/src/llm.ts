import Anthropic from '@anthropic-ai/sdk';
import type { RuntimeConfig } from './config.js';
import type { DeepDive, PreScoredItem, RankedItem, TopicsConfig } from './types.js';
import { log, mapLimit, truncate } from './util.js';

export const CATEGORIES = [
  'リリース/アップデート',
  '新機能・新ツール',
  '設計・実装ノウハウ',
  'パフォーマンス',
  'AI/エージェント',
  'Web標準/ブラウザ',
  '調査・考察',
  'その他',
] as const;

let client: Anthropic | null = null;

export function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  client ??= new Anthropic();
  return client;
}

/**
 * Haiku 4.5 / Sonnet 4.5 世代は adaptive thinking と effort を受け付けないため、
 * これらのパラメータを付けずに呼ぶ必要がある。
 */
function isLegacyModel(model: string): boolean {
  return /haiku-4-5|sonnet-4-5|opus-4-5|haiku-3|sonnet-3/.test(model);
}

function extractJson(res: Anthropic.Message): unknown {
  if (res.stop_reason === 'refusal') {
    throw new Error('モデルが応答を拒否しました (stop_reason=refusal)');
  }
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new Error(`テキストブロックがありません (stop_reason=${res.stop_reason})`);
  try {
    return JSON.parse(text);
  } catch {
    // structured outputs でもごく稀に前後に文字が付くことがある
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('JSON をパースできませんでした');
    return JSON.parse(text.slice(start, end + 1));
  }
}

/* ------------------------------------------------------------------ *
 * 1) ランキング（安価なモデルで一括スコアリング）
 * ------------------------------------------------------------------ */

const RANK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: '入力に付与した番号' },
          score: { type: 'integer', description: '0〜100 の関連度スコア' },
          category: { type: 'string', enum: [...CATEGORIES] },
          oneLiner: { type: 'string', description: '日本語1文の要約（60字以内）' },
          reason: { type: 'string', description: 'このスコアにした理由（日本語40字以内）' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '検索用キーワード3〜6個（固有名詞優先）',
          },
        },
        required: ['ref', 'score', 'category', 'oneLiner', 'reason', 'keywords'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

interface RankResponseItem {
  ref: number;
  score: number;
  category: string;
  oneLiner: string;
  reason: string;
  keywords: string[];
}

function rankSystemPrompt(topics: TopicsConfig): string {
  const topicList = topics.topics
    .map((t) => `- ${t.name}（重要度 ${t.weight}/5）: ${t.keywords.slice(0, 8).join(', ')}`)
    .join('\n');

  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡された記事リストを、この読者にとっての「今日読む価値」で 0〜100 点に採点してください。

# 読者プロフィール
${topics.profile}

# 関心トピック
${topicList}

# 採点基準
- 90-100: 読者が日常的に使う技術の重大な変更・新機能。今日知らないと損をするレベル。
- 70-89 : 関心トピックど真ん中で、実装や意思決定に直接影響する具体的な内容。
- 50-69 : 関心はあるが緊急度は低い。あとで読めばよい良記事。
- 30-49 : 隣接領域。読者の主戦場からは少し遠い。
- 0-29  : 無関係、入門記事の焼き直し、宣伝、ポエム、内容の薄いまとめ。

# 重要な判断ルール
- 一次情報（公式リリースノート、公式ブログ、仕様策定）は二次情報より高く評価する。
- 「〜してみた」「入門」「まとめ」系は、独自の検証や数値がない限り 40 点以下。
- 人気（いいね数・スター数）は参考程度。読者の関心との一致を最優先する。
- 同じ話題の記事が複数あるときは、最も一次情報に近く情報量の多いものを高くする。
- 日本語・英語で有利不利をつけない。

# 出力
- すべて日本語で書く。
- oneLiner は「何が起きたか」を主語述語のある1文で。「〜について」のような曖昧な書き方は禁止。
- keywords は後から検索するためのもの。製品名・API名・バージョン番号などの固有名詞を優先する。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。`;
}

function renderCandidate(item: PreScoredItem, ref: number): string {
  const m = item.metrics;
  const signals = [
    m.likes != null ? `LGTM/いいね ${m.likes}` : null,
    m.stocks != null ? `ストック ${m.stocks}` : null,
    m.hatena != null ? `はてブ ${m.hatena}` : null,
    m.points != null ? `HN ${m.points}pt` : null,
    m.stars != null ? `★${m.stars}` : null,
  ]
    .filter(Boolean)
    .join(' / ');

  const excerpt = truncate((item.body || item.snippet).replace(/\s+/g, ' ').trim(), 700);

  return [
    `[${ref}] ${item.title}`,
    `  ソース: ${item.sourceLabel}`,
    item.tags.length ? `  タグ: ${item.tags.slice(0, 8).join(', ')}` : null,
    signals ? `  指標: ${signals}` : null,
    item.matchedTopics.length ? `  事前マッチ: ${item.matchedTopics.join(', ')}` : null,
    `  抜粋: ${excerpt || '(本文なし)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function rankItems(
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<RankedItem[]> {
  const anthropic = getClient();
  if (!anthropic) {
    log.warn('ANTHROPIC_API_KEY が無いためルールベースのスコアにフォールバックします');
    return items.map((item) => ({
      ...item,
      score: Math.round(item.preScore * 100),
      oneLiner: truncate(item.snippet.replace(/\s+/g, ' ').trim(), 80) || item.title,
      reason: '事前スコアのみ（LLM 未使用）',
      keywords: item.matchedTopics.slice(0, 5),
      category: 'その他',
    }));
  }

  const batches: PreScoredItem[][] = [];
  for (let i = 0; i < items.length; i += cfg.rankBatchSize) {
    batches.push(items.slice(i, i + cfg.rankBatchSize));
  }

  const system = rankSystemPrompt(topics);
  const isLegacy = isLegacyModel(cfg.rankModel);

  const scored = new Map<string, RankResponseItem>();

  await mapLimit(batches, 3, async (batch, batchIndex) => {
    const offset = batchIndex * cfg.rankBatchSize;
    const body = batch.map((item, i) => renderCandidate(item, offset + i)).join('\n\n');

    try {
      const res = await anthropic.messages.create({
        model: cfg.rankModel,
        max_tokens: 8000,
        system,
        messages: [
          {
            role: 'user',
            content: `以下 ${batch.length} 件を採点してください。\n\n${body}`,
          },
        ],
        output_config: { format: { type: 'json_schema', schema: RANK_SCHEMA } },
        // Haiku 4.5 世代は adaptive thinking を受け付けない
        ...(isLegacy ? {} : { thinking: { type: 'adaptive' as const } }),
      });

      const parsed = extractJson(res) as { items: RankResponseItem[] };
      for (const r of parsed.items ?? []) {
        const item = items[r.ref];
        if (item) scored.set(item.id, r);
      }
    } catch (err) {
      log.warn(`ランキング batch ${batchIndex}: ${err instanceof Error ? err.message : err}`);
    }
  });

  log.info(`  LLM 採点: ${scored.size}/${items.length} 件`);

  return items.map((item) => {
    const r = scored.get(item.id);
    if (!r) {
      return {
        ...item,
        score: Math.round(item.preScore * 60), // 未採点は控えめに
        oneLiner: truncate(item.snippet.replace(/\s+/g, ' ').trim(), 80) || item.title,
        reason: '採点失敗（事前スコアで代替）',
        keywords: item.matchedTopics.slice(0, 5),
        category: 'その他',
      };
    }
    return {
      ...item,
      score: Math.max(0, Math.min(100, Math.round(r.score))),
      oneLiner: r.oneLiner?.trim() || item.title,
      reason: r.reason?.trim() ?? '',
      keywords: (r.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
      category: CATEGORIES.includes(r.category as (typeof CATEGORIES)[number])
        ? r.category
        : 'その他',
    };
  });
}

/* ------------------------------------------------------------------ *
 * 2) 深掘り要約（高性能モデル）
 * ------------------------------------------------------------------ */

/** visual フィールドの 3 バリアント */
const VISUAL_VARIANTS = [
  {
    type: 'object',
    description: '変更前後の対比。「何が変わるか」がある記事に最も合う。',
    properties: {
      type: { type: 'string', enum: ['comparison'] },
      title: { type: 'string', description: '何と何を比べているか。20字以内。' },
      beforeLabel: { type: 'string', description: '左側の見出し（例: 従来 / v1 まで）' },
      afterLabel: { type: 'string', description: '右側の見出し（例: 今回 / v2 以降）' },
      rows: {
        type: 'array',
        description: '比較の観点ごとに1行。2〜5行。',
        items: {
          type: 'object',
          properties: {
            aspect: { type: 'string', description: '観点（例: 書き方、デフォルト値）' },
            before: { type: 'string' },
            after: { type: 'string' },
          },
          required: ['aspect', 'before', 'after'],
          additionalProperties: false,
        },
      },
    },
    required: ['type', 'title', 'beforeLabel', 'afterLabel', 'rows'],
    additionalProperties: false,
  },
  {
    type: 'object',
    description: '処理やワークフローの流れ。順序が本質的な記事に合う。',
    properties: {
      type: { type: 'string', enum: ['flow'] },
      title: { type: 'string', description: '何の流れか。20字以内。' },
      steps: {
        type: 'array',
        description: '3〜6ステップ。',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'ステップ名。12字以内。' },
            detail: { type: 'string', description: 'そのステップで起きること。30字以内。' },
          },
          required: ['label', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['type', 'title', 'steps'],
    additionalProperties: false,
  },
  {
    type: 'object',
    description: '記事に具体的な数値がある場合のみ。無い数値を作らないこと。',
    properties: {
      type: { type: 'string', enum: ['metrics'] },
      title: { type: 'string', description: '何の数値か。20字以内。' },
      items: {
        type: 'array',
        description: '1〜4個。',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '指標名（例: ビルド時間）' },
            value: { type: 'string', description: '変更後の値（単位込み。例: 12s）' },
            baseline: {
              description: '変更前の値。比較対象が無ければ null。',
              anyOf: [{ type: 'null' }, { type: 'string' }],
            },
            direction: {
              type: 'string',
              enum: ['up-good', 'down-good', 'neutral'],
              description: '値が増えるのが良いか減るのが良いか',
            },
            note: {
              description: '測定条件などの補足。無ければ null。',
              anyOf: [{ type: 'null' }, { type: 'string' }],
            },
          },
          required: ['label', 'value', 'baseline', 'direction', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['type', 'title', 'items'],
    additionalProperties: false,
  },
];

const DEEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '結論を1文で。40字以内。' },
    summary: { type: 'string', description: '概要。3〜5文、記事を読まなくても要点が掴める粒度。' },
    prerequisites: {
      type: 'array',
      description:
        'この記事を読む前に知っておくべき前提知識。2〜4個。記事の前提になっている概念や、知っていると凄さがわかる周辺知識。',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '用語や概念の名前。20字以内。' },
          explanation: {
            type: 'string',
            description: 'その分野に詳しくない人にも伝わる説明。2〜3文。',
          },
        },
        required: ['term', 'explanation'],
        additionalProperties: false,
      },
    },
    visual: {
      description:
        '記事の要点を図にしたもの。最も内容に合う形式を1つ選ぶ。図にする価値が無ければ null。',
      anyOf: [{ type: 'null' }, ...VISUAL_VARIANTS],
    },
    whatYouCanDo: {
      type: 'array',
      items: { type: 'string' },
      description: '何ができるようになるか。2〜4個。',
    },
    whatChanges: {
      type: 'array',
      items: { type: 'string' },
      description: '何が変わるか（従来との差分・破壊的変更・移行の要否）。2〜4個。',
    },
    howToTry: {
      type: 'array',
      items: { type: 'string' },
      description: '試し方・使い方の手順。2〜5ステップ。具体的なコマンドや設定を含める。',
    },
    code: {
      description: '手を動かすときにそのまま使えるコード。不要なら null。',
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            lang: { type: 'string' },
            caption: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['lang', 'caption', 'content'],
          additionalProperties: false,
        },
      ],
    },
    whyItMatters: { type: 'string', description: 'この読者にとってなぜ重要か。2〜3文。' },
    caveats: {
      type: 'array',
      items: { type: 'string' },
      description: '注意点・制限・まだ使えない条件。無ければ空配列。',
    },
    relatedLinks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        required: ['label', 'url'],
        additionalProperties: false,
      },
      description: '記事本文中にあった一次情報へのリンク。無ければ空配列。',
    },
    readingMinutes: { type: 'integer', description: 'このカードを読むのにかかる分数の目安' },
  },
  required: [
    'headline',
    'summary',
    'prerequisites',
    'visual',
    'whatYouCanDo',
    'whatChanges',
    'howToTry',
    'code',
    'whyItMatters',
    'caveats',
    'relatedLinks',
    'readingMinutes',
  ],
  additionalProperties: false,
};

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
- 「これを知らないと記事の意味がわからない」「これを知っていると凄さがわかる」ものを選ぶ。
- 読者プロフィールに書かれている技術は既知として扱い、説明しない。React を使う読者に「React とは」を書かない。
- 逆に、読者の主戦場から外れた領域（低レイヤ、他言語のエコシステム、専門用語）は丁寧に説明する。
- 記事本文で説明されている内容の繰り返しではなく、記事が説明を省略している前提を埋める。
- 用語の辞書的定義で終わらせず、「なぜそれが問題になるのか」まで書く。

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
  const anthropic = getClient();
  if (!anthropic) return fallbackDeepDive(item);

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
    const res = await anthropic.messages.create({
      model: cfg.summaryModel,
      max_tokens: 12_000,
      system: deepSystemPrompt(topics),
      messages: [
        {
          role: 'user',
          content: `${meta}\n\n--- 本文ここから ---\n${content}\n--- 本文ここまで ---`,
        },
      ],
      output_config: {
        effort: cfg.summaryEffort,
        format: { type: 'json_schema', schema: DEEP_SCHEMA },
      },
      thinking: { type: 'adaptive' },
    });

    const parsed = extractJson(res) as DeepDive;
    return {
      headline: parsed.headline?.trim() || item.oneLiner,
      summary: parsed.summary?.trim() || item.oneLiner,
      prerequisites: (parsed.prerequisites ?? []).filter((p) => p?.term && p?.explanation),
      visual: normalizeVisual(parsed.visual),
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
