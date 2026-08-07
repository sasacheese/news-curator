import { z } from 'zod';
import { CATEGORIES } from './categories.js';
import { DURABILITIES, RELEASE_IMPACTS, RELEASE_KINDS } from './types.js';

/**
 * LLM に返させる構造の定義元。
 *
 * Anthropic API 経由（本番）と Claude Code CLI 経由（ローカル開発）の
 * 両方で同じ型を使うため、Zod を単一の定義元にしている。
 * - Anthropic: zodOutputFormat() で JSON Schema に変換
 * - Claude Code: AI SDK の Output.object() にそのまま渡す
 */

/** 1 段目: 関連度スコアだけ。出力を最小にする。 */
export const ScoreResultSchema = z.object({
  items: z
    .array(
      z.object({
        ref: z.number().int().describe('入力に付与した番号'),
        score: z.number().int().describe('0〜100 の関連度スコア'),
      }),
    )
    .describe('入力されたすべての ref に対して1件ずつ'),
});

/**
 * 2 段目: 保存する分だけの要約とキーワード。
 *
 * enum には .catch() で既定値を付けている。zodOutputFormat は Zod の enum を
 * JSON Schema の enum キーワードに変換せず、許容値を description に載せるだけなので、
 * 生成側では制約されない。1 件が枠外の値を返すとバッチ全体（25 件）の検証が落ち、
 * 全部がルールベースにフォールバックする——実際に本番で毎日そうなっていた。
 * 既定値に丸めれば、落ちるのはその 1 件のカテゴリだけで済む。
 */
export const DescribeResultSchema = z.object({
  items: z.array(
    z.object({
      ref: z.number().int().describe('入力に付与した番号'),
      /*
       * .catch() は description に default を書き込むので、指示が無いと
       * モデルが既定値をそのまま返す（実測で 18 件すべて「その他」になった）。
       * 何を選ぶかを明示する。
       */
      category: z
        .enum(CATEGORIES)
        .catch('その他')
        .describe(
          `記事の分類。次から最も近いものを1つ選ぶ: ${CATEGORIES.join(' / ')}。どれにも当てはまらないときだけ「その他」にする。`,
        ),
      oneLiner: z.string().describe('日本語1文の要約（60字以内）'),
      reason: z
        .string()
        .describe(
          '記事が明らかにした事実を、その分野を知らない人にも通じる平易な言葉で書く。2文以内・100字以内。読者を主語にしない（「〜するなら」で始めない、「参考になる」「材料になる」で終わらない）。分からない固有名詞を並べない。数字は残す。',
        ),
      keywords: z.array(z.string()).describe('検索用キーワード3〜6個（固有名詞優先）'),
      domain: z
        .enum(['ai', 'general'])
        .catch('general')
        .describe(
          'ai = LLM・生成AI・AIエージェント・コーディングエージェントが主題。それ以外は general。AI をツールとして使っているだけの記事は general。',
        ),
      readingMinutes: z
        .number()
        .int()
        .describe('元記事を読み通すのにかかる分数の目安。1〜30。'),
      payoff: z
        .enum(['apply', 'decide', 'aware'])
        .catch('aware')
        .describe(
          'apply = 読めば今日のコードにすぐ適用できる（具体的な手順やコードがある） / decide = 技術選定や設計の判断材料になる / aware = 今すぐの行動は不要だが知っておくと後で効く',
        ),
      durability: z
        .enum(DURABILITIES)
        .catch('durable')
        .describe(
          'この情報が何年もつか。foundational = 言語仕様・標準・ブラウザ実装・プロトコル・アルゴリズムなど、数年単位で効く / durable = ライブラリのメジャー変更・設計や運用の知見など、1年程度は効く / ephemeral = 特定ツールの今の使いこなし・回避策・「試してみた」など、数週間〜数ヶ月で陳腐化する',
        ),
    }),
  ),
});

/** リリース情報の抽出。ランキングしないので、判定と要約だけ返させる。 */
export const ReleaseResultSchema = z.object({
  items: z.array(
    z.object({
      ref: z.number().int().describe('入力に付与した番号'),
      isRelease: z
        .boolean()
        .describe(
          'ソフトウェアやモデルの「出荷」の告知なら true。事業提携・料金改定・導入事例・解説記事は false。',
        ),
      product: z.string().describe('製品・ライブラリ・モデルの名前。例: Vite, Playwright, Gemini'),
      what: z
        .string()
        .nullable()
        .describe(
          'その製品が「何をするものか」を端的に。20〜40字。例: 「Cloudflare Workers のデプロイ CLI」。知らない製品なら推測せず null。',
        ),
      version: z.string().nullable().describe('バージョン。無ければ null。例: v8.2.0'),
      kind: z
        .enum(RELEASE_KINDS)
        .catch('minor')
        .describe(
          'ai-model=新しいAIモデル / major=メジャー版・GA・新規公開 / minor=機能追加 / patch=修正のみ / service=SaaSの機能追加',
        ),
      impact: z
        .enum(RELEASE_IMPACTS)
        .catch('chore')
        .describe(
          'unlocks=これまでできなかったことができるようになる / security=脆弱性の修正 / improves=できていたことが速い・安い・楽になる / chore=修正のみ',
        ),
      unlock: z
        .string()
        .nullable()
        .describe(
          '何ができるようになるかを「〜できるようになる」の形で1文。50字以内。バージョン番号や修正件数ではなく、読者の側から見て何が可能になるかを書く。新しくできることが無ければ null。',
        ),
      changeBefore: z
        .string()
        .nullable()
        .describe(
          '今までどうだったか。20〜40字。「1サンドボックスにエージェント1つ」のように具体的に。記事から読み取れなければ null。',
        ),
      changeAfter: z
        .string()
        .nullable()
        .describe('これからどうなるか。20〜40字。changeBefore と対になるように書く。無ければ null。'),
      scope: z
        .array(z.string())
        .describe(
          '新たに対応した環境や範囲だけを挙げる。例: iOS / Android / Web / CLI / セルフホスト / 無料プラン。対応範囲が広がっていなければ空配列。',
        ),
      summary: z
        .string()
        .describe('何が入ったかを1〜2文で。「リリースされました」で終わらせず中身を書く。'),
    }),
  ),
});

/** 冒頭サマリー。個々の記事の紹介ではなく、その日の技術界隈の傾向を3〜5行で書く。 */
export const DigestSummarySchema = z.object({
  lines: z
    .array(z.string())
    .describe(
      'その日の技術界隈の傾向・インサイト3〜5行。各行1文、40字前後の平易な日本語。個々の記事要約の言い換えではなく、複数項目を束ねた傾向を書く。',
    ),
});

/**
 * 冒頭サマリーの最後に置く「この先の見立て」。
 * サマリー本体が「今日の材料から読み取れることだけ」なのに対し、
 * こちらだけは数日分の流れからの推測を許す（時流を読む助けが目的）。
 */
export const DigestOutlookSchema = z.object({
  outlook: z
    .string()
    .describe(
      'エンジニアリング業界の現状の位置づけと、この先の方向を1行（1〜2文・90〜130字）で書く。推測が分かる語尾を使い、材料に無い固有名詞や数字を作らない。',
    ),
});

const PrerequisiteSchema = z.object({
  term: z
    .string()
    .describe(
      'このカードの summary・箇条書き・whyItMatters の中で実際に使った語を、一字一句そろえて書く（画面でその語に注釈を付けるため）。短い名詞か識別子で25字以内。文にしない。',
    ),
  stumblingPoint: z
    .string()
    .describe(
      '記事のどこで詰まるか。記事中の語や一文を引いて「〜と書かれているが、〜を知らないと〜が読み取れない」の形で具体的に書く。40〜80字。',
    ),
  explanation: z
    .string()
    .describe(
      'その詰まりを解消する解説。3〜5文。定義だけで終わらせず、なぜそれが問題になるのか・この記事の文脈で何を意味するのかまで書く。',
    ),
});

const ComparisonSchema = z.object({
  type: z.literal('comparison'),
  title: z.string().describe('何と何を比べているか。20字以内。'),
  beforeLabel: z.string().describe('左側の見出し（例: 従来 / v1 まで）'),
  afterLabel: z.string().describe('右側の見出し（例: 今回 / v2 以降）'),
  rows: z
    .array(
      z.object({
        aspect: z.string().describe('観点（例: 書き方、デフォルト値）'),
        before: z.string(),
        after: z.string(),
      }),
    )
    .describe('比較の観点ごとに1行。2〜5行。'),
});

const FlowSchema = z.object({
  type: z.literal('flow'),
  title: z.string().describe('何の流れか。20字以内。'),
  steps: z
    .array(
      z.object({
        label: z.string().describe('ステップ名。12字以内。'),
        detail: z.string().describe('そのステップで起きること。30字以内。'),
      }),
    )
    .describe('3〜6ステップ。'),
});

const MetricsSchema = z.object({
  type: z.literal('metrics'),
  title: z.string().describe('何の数値か。20字以内。'),
  items: z
    .array(
      z.object({
        label: z.string().describe('指標名（例: ビルド時間）'),
        value: z.string().describe('変更後の値（単位込み。例: 12s）'),
        baseline: z.string().nullable().describe('変更前の値。比較対象が無ければ null。'),
        direction: z
          .enum(['up-good', 'down-good', 'neutral'])
          .catch('neutral')
          .describe('値が増えるのが良いか減るのが良いか'),
        note: z.string().nullable().describe('測定条件などの補足。無ければ null。'),
      }),
    )
    .describe('1〜4個。記事に実際の数値がある場合のみ。'),
});

export const DeepDiveSchema = z.object({
  headline: z.string().describe('結論を1文で。40字以内。'),
  summary: z.string().describe('概要。3〜5文、記事を読まなくても要点が掴める粒度。'),
  prerequisites: z
    .array(PrerequisiteSchema)
    .describe(
      '読者が詰まりそうな箇所を先回りして埋める解説。4〜8個で網羅側に倒す（迷ったら入れる）。term は自分が summary や箇条書きで実際に使った語とそろえる。本当に詰まる箇所が無ければ空配列。',
    ),
  visual: z
    .union([ComparisonSchema, FlowSchema, MetricsSchema])
    .nullable()
    .describe('記事の要点の図。最も合う形式を1つ選ぶ。図にする価値が無ければ null。'),
  whatYouCanDo: z.array(z.string()).describe('何ができるようになるか。2〜4個。'),
  whatChanges: z
    .array(z.string())
    .describe('何が変わるか（従来との差分・破壊的変更・移行の要否）。2〜4個。'),
  howToTry: z
    .array(z.string())
    .describe('試し方・使い方の手順。2〜5ステップ。具体的なコマンドや設定を含める。'),
  code: z
    .object({
      lang: z.string(),
      caption: z.string(),
      content: z.string(),
    })
    .nullable()
    .describe('そのまま使えるコード。不要なら null。'),
  whyItMatters: z.string().describe('この読者にとってなぜ重要か。2〜3文。'),
  caveats: z.array(z.string()).describe('注意点・制限。無ければ空配列。'),
  relatedLinks: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .describe('記事本文中にあった一次情報へのリンク。無ければ空配列。'),
  readingMinutes: z.number().int().describe('このカードを読むのにかかる分数の目安'),
});

export type ScoreResult = z.infer<typeof ScoreResultSchema>;
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
export type DeepDiveResult = z.infer<typeof DeepDiveSchema>;
export type DigestSummaryResult = z.infer<typeof DigestSummarySchema>;
