import type { LlmBackend } from './backend.js';
import { selectBackend } from './backend.js';
import { CATEGORIES } from './categories.js';
import type { RuntimeConfig } from './config.js';
import { MAX_BODY_IMAGES, type BodyImage } from './image.js';
import {
  BuildDeepDiveSchema,
  DescribeResultSchema,
  KnowDeepDiveSchema,
  TalkDeepDiveSchema,
  DigestOutlookSchema,
  DigestSummarySchema,
  ScoreResultSchema,
  TalkDescribeResultSchema,
  type BuildDeepDiveResult,
  type DescribeItem,
  type KnowDeepDiveResult,
  type TalkDeepDiveResult,
} from './schemas.js';
import { pickTopDiverse } from './prescore.js';
import { DURABILITIES, LANES, LANE_LABELS, PAYOFFS } from './types.js';
import type {
  Debate,
  DeepDive,
  Figure,
  Lane,
  PreScoredItem,
  RankedItem,
  ReleaseItem,
  TopicsConfig,
  TopItem,
  UsageReport,
  UsageStat,
} from './types.js';
import { sanitizeTryPrompt } from './try-prompt.js';
import { hasKana, log, mapLimit, truncate } from './util.js';

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
/**
 * Sonnet 5 の $2/$10 は 2026-08-31 までの導入価格。
 * 期限を過ぎたら $3/$15 に戻るので、表示コストが 50% 過小にならないよう切り替える。
 */
const SONNET_5_INTRO_UNTIL = Date.parse('2026-09-01T00:00:00Z');
const sonnet5Price = () =>
  Date.now() < SONNET_5_INTRO_UNTIL
    ? { input: 2, output: 10, cacheRead: 0.2 }
    : { input: 3, output: 15, cacheRead: 0.3 };

const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  // 比較用。272K トークンを超える入力は $0.40/$1.80 に上がるが、ここでは扱わない
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02 },
  get 'claude-sonnet-5'() {
    return sonnet5Price();
  },
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
  elapsedMs: number,
): void {
  const price = metered ? PRICING[model] : undefined;
  const prev = usageByStage.get(stage) ?? {
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    elapsedMs: 0,
  };

  usageByStage.set(stage, {
    model,
    requests: prev.requests + 1,
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
    elapsedMs: prev.elapsedMs + elapsedMs,
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
export async function complete<T>(
  b: LlmBackend,
  opts: Parameters<LlmBackend['complete']>[0] & { schema: import('zod').ZodType<T> },
): Promise<T> {
  const startedAt = Date.now();
  const res = await b.complete<T>(opts);
  recordUsage(opts.stage, opts.model, res.usage, b.metered, Date.now() - startedAt);
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

function readerContext(topics: TopicsConfig, feedbackNote?: string | null): string {
  const topicList = topics.topics
    .map((t) => `- ${t.name}（重要度 ${t.weight}/5）: ${t.keywords.slice(0, 8).join(', ')}`)
    .join('\n');
  const feedback = feedbackNote ? `\n\n# 読者の最近の反応\n${feedbackNote}` : '';
  return `# 読者プロフィール\n${topics.profile}\n\n# 関心トピック\n${topicList}${feedback}`;
}

/**
 * レーンごとの採点基準。
 *
 * 以前はひとつの「今日読む価値 0〜100」で採点していたが、それだと 3 つの目的が
 * ひとつの尺度に潰れ、いちばん測りやすいもの（関心トピックとの一致）だけが残る。
 * 目的ごとに別の問いを立て、別の証拠で採点する。
 *
 * 各レーンの末尾に置いた「判定の問い」がいちばん効く。基準表よりも、
 * 答えられなければ落とす、という 1 つの問いのほうが境界が安定する。
 */
const LANE_RUBRICS: Record<Lane, string> = {
  know: `# このレーンの目的
「知っておかないと判断を間違えるもの」だけを拾う。**読者の関心領域かどうかは問わない。**
ハードウェアの価格、企業の買収、規制、大規模障害のように、読者の関心トピック一覧に
無い話題でも、規模が大きければ高く採点する。関心トピックは、同点のときの並べ替えにだけ使う。

# 採点基準（規模 = 影響を受ける人数 × 取り返しのつかなさ）
- 90-100: 業界全体が動く。広範囲のサプライチェーン攻撃、主要プラットフォームの提供終了、
  大手の買収、価格や供給構造の変化。知らなければ確実に判断を誤る。
- 70-89 : 読者の周辺で確実に影響が出る。使っている可能性の高い基盤の重大な変更、
  期限のある廃止、深刻度の高い脆弱性。
- 50-69 : 影響はあるが限定的。特定の環境・特定の使い方でだけ問題になる。
- 30-49 : 知っていれば少し役に立つ程度。行動は変わらない。
- 0-29  : 個人の作業記録、宣伝、入門、感想。規模の話ではない。

# 幹と枝を分ける ← このレーンで一番大事な判断
**幹を知っていれば導けるものは、枝である。枝は 40 点を超えさせない。**
- 幹「npm に大規模なサプライチェーン攻撃」/ 枝「個別パッケージのパッチ公開」
- 幹「PC の価格が高騰している」/ 枝「整備済み品の在庫が増えた」
- 幹「モデルの世代交代が起きた」/ 枝「それに伴う料金表の改定」
迷ったら「これは事象そのものか、事象の帰結か」を問う。帰結なら枝。

# 判定の問い
**「これを知らないまま1週間過ごしたとき、読者は何を間違えるか」**
具体的に答えられないなら 40 点未満。「なんとなく知っておくとよい」は答えではない。`,

  build: `# このレーンの目的
「読んだら手を動かしたくなるもの」を拾う。読者が探しているのは、新しい道具と、
作れるものの幅が広がる変化。

# 採点基準（可能性の差分 × 触れる実体）
- 90-100: これまで作れなかったものが作れるようになる。全く新しい種類の道具
  （エディタ、ターミナル、ランタイム、パッケージ管理、言語、フレームワーク）や、
  能力の段が上がったモデル・API。しかも今日インストールして試せる。
- 70-89 : できることの幅が広がる。新しいライブラリや手法で、手順とコードがあり試せる。
- 50-69 : 手を動かす具体はあるが、既にできていたことがやりやすくなるだけ。
  読者のスタック（React / Next.js / TypeScript など）の実装ノウハウは基本ここ。
- 30-49 : 概念や構想の紹介で、今すぐ触れる実体が無い。
- 0-29  : 宣伝、内容の薄いまとめ、感想。

# 程度と種類を分ける ← このレーンで一番大事な判断
**「速くなった・便利になった」は程度の改善であって、差分ではない。
「できなかったことができる」が差分。** 種類が変わったものを上に置く。
- 差分:「ブラウザだけで動画のエンコードができるようになった」
- 程度:「ビルドが2倍速くなった」（有用だが、作れるものは変わらない）
ただし桁が変わって使い方そのものが変わるなら、程度の改善でも差分として扱ってよい。

# 触れる実体があるか
今日インストールして動かせるか。リポジトリ・インストール手順・動くデモ・コード片の
どれかがあること。研究発表・構想・ロードマップだけのものは 40 点を超えさせない。
「すごそう」で終わるものは試したくならない。

# 新しさの扱い
読者がまだ名前を聞いたことがなさそうなものを、既知のものより高く置く。
**知らない名前が出てきたことを減点の理由にしない。** それは新しさの証拠であって、
無関係さの証拠ではない。

# 判定の問い
**「これの前後で、作れるものの集合はどう変わったか」**
「同じものがより楽に作れる」しか答えられないなら 60 点未満。`,

  talk: `# このレーンの目的
「読者が自分の意見を言える記事」を拾う。SNS で発信するための素材なので、
正しさや一次情報らしさより **立場が割れること** を優先する。

# 採点基準（立場が割れること）
- 90-100: 同じ事実から正反対の結論が出る。実際に界隈で意見が割れていて、
  賛成側も反対側も具体的な根拠を持てる。
- 70-89 : 明確な主張があり、反論が成り立つ。設計論、やめた話、比較検証、失敗談。
- 50-69 : 主張はあるが反論しづらい（ほぼ誰もが同意する）。
- 30-49 : 事実の報告で、立場の取りようが無い。
- 0-29  : 宣伝、単なる手順書、中身のない感想。

# 判定の問い ← このレーンで一番大事な判断
**「反対の立場を、藁人形にせず1文で書けるか」**
書けないものは論点ではなく事実。事実を扱うのは別のレーンの仕事なので、ここでは 40 点未満。

# 争われているのは優先順位である
賛否の本質は「どちらが正しいか」ではなく「何を優先するか」が違うこと。
速さ vs 安全、自動化 vs 制御、統一 vs 自由、今の生産性 vs 将来の保守性。
この形に還元できる記事を高く置く。事実の正誤が争われているだけのものは論点ではない。

# このレーンでは一次情報を優遇しない
公式のリリースノートに意見は書けない。個人の主張・検証・体験談のほうがここでは価値が高い。
**「〜してみた」「やめた」「後悔した」を、その形だからという理由で減点しない。**
ただし主張が無く手順だけのものは 40 点未満。`,
};

function scoreSystemPrompt(
  lane: Lane,
  topics: TopicsConfig,
  feedbackNote?: string | null,
): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡された記事を、下に示すひとつの目的に照らして 0〜100 点に採点してください。
**この目的以外の良さで加点しない。** 良い記事でも、この目的に沿わなければ低くつけます。

${readerContext(topics, feedbackNote)}

${LANE_RUBRICS[lane]}

# 共通のルール
- 日本語・英語で有利不利をつけない。
- 人気（いいね数・順位）は参考程度。目的との一致を優先する。
- 同じ話題の記事が複数あるときは、この目的をいちばん強く満たす1本を高くする。

# 出力
- 説明や理由は書かず、ref と score だけを返す。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。`;
}

/**
 * レーンごとに、要約で何に焦点を当てるかの指示。
 * talk レーンだけは項目自体が増える（意見の足場）。
 */
const LANE_DESCRIBE_BLOCKS: Record<Lane, string> = {
  know: `# このレーンについて
これらは「知っておかないと判断を間違えるもの」として選ばれている。
takeaways には規模が伝わる具体を必ず入れる——何に、いつから、どれくらいの範囲で効くのか。
「重要な変更があった」で終わらせない。期限があるなら日付を、範囲があるなら対象を書く。`,

  build: `# このレーンについて
これらは「試してみたくなるもの」として選ばれている。
takeaways には「これまでできなかった何ができるようになるか」を入れる。
できるようになることが無く、既存のやり方が楽になるだけなら、それを率直にそう書く。
無理に「新しくできること」をひねり出さない。`,

  talk: `# このレーンについて
これらは「読者が自分の意見を言えるもの」として選ばれている。
通常の項目に加えて、debate の 5 項目を書くこと。

# debate（意見の足場）
読者はこれを見て SNS に投稿する。**意見の下書きは書かない。**
下書きを渡すと読者自身の言葉でなくなるうえ、裏を取っていない文章がそのまま外に出る。
渡すのは、読者が自分で書き始められる足場だけ。

- **debateAxis は「A か B か」の形にする。**「〜について」は争点ではない。
  優先順位の対立に還元する（速さ vs 安全、自動化 vs 制御、統一 vs 自由、
  今の生産性 vs 将来の保守性）。
- **debateFor / debateAgainst は、それぞれの立場の一番強い言い分を書く。**
  反対側を弱く書かない。実際にその立場を取る人が言うことを書く。
  藁人形を立てると、読者がそれを引用した時点で恥をかく。
- 記事が片側の立場しか書いていないなら **debateOneSided を true** にする。
  そのとき debateAgainst は記事の外から補った一般論なので、記事の主張として
  読める書き方をしない。
- **debateYourAngle は読者プロフィールとの接点。** 「読者が実体験として持っている
  一次情報はどこか」を指す。意見そのものは書かない。
  ✗「自動化には慎重であるべきだと言える」（意見の代筆）
  ✓「同じ構成を業務で毎日動かしているので、手戻りの頻度は実測値として出せる」
- **争点が本当に無い記事なら、5 項目すべて null / false にする。無理に作らない。**
  事実の報告に無理やり争点をかぶせるのが、この項目で一番やってはいけないこと。`,
};

function describeSystemPrompt(
  lane: Lane,
  topics: TopicsConfig,
  feedbackNote?: string | null,
): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
選抜済みの記事について、一覧に載せる要約とキーワードを書いてください。

${readerContext(topics, feedbackNote)}

# 出力
- すべて日本語で書く。
- titleJa は画面の見出しに出す日本語のタイトル。詳しくは下の節を参照。
- oneLiner は「何が起きたか」を主語述語のある1文で。「〜について」のような曖昧な書き方は禁止。
- takeaways は「忙しい人のための3行」。詳しくは下の節を参照。
- keywords は後から検索するためのもの。製品名・API名・バージョン番号などの固有名詞を優先する。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# titleJa（日本語の見出し）
画面のカードの見出しは元記事のタイトルをそのまま出す。日本語の記事はそれでよいが、
外国語の記事はそこだけ外国語で残り、日本語の要約の中で読めない塊になる。
その差し替え用の見出しなので、**書くかどうかは仮名の有無だけで決める。**

- 元タイトルに仮名（ひらがな・カタカナ）が **1 文字も無いなら、必ず書く。**
  英語だけでなく、中国語・韓国語・漢字だけのタイトルもすべてここに入る。
- 元タイトルに仮名が **あるなら null。** 原題が一番正確な題なので、書き換えない
  （英単語が混ざっていても、仮名があるなら日本語のタイトルである）。

書くときは、次の形にする。
- **1 行・40 字以内。句点で終わらせない。** 体言止めでよい。
- 直訳ではなく「何の話か」が分かる言葉にする。原題の語順に引っぱられない。
- **製品名・リポジトリ名・組織名・バージョン番号は原語のまま残す。** 訳すと検索で引けなくなる。
- GitHub のリポジトリ（owner/repo — 英語の説明文）は「repo 名 — 何をするものか」にする。
  owner 名は落とす。説明文をぜんぶ入れようとしない——主な用途 1 つに絞る。
- 煽らない。「必見」「話題の」「〜が凄い」は書かない。

✗「Buyer-run, ad-neutral shopping-agent MCP software with deterministic ranking」（英語のまま）
✗「購入者が実行する広告中立のショッピングエージェント MCP ソフトウェア」（直訳。何をするものか分からない）
✓「northcinder — 買い物を代行する AI エージェントの土台」

✗「Plugin and skin collection for DeepSeek Harness (DSH) Web UI - task board, git graph...」（英語のまま・長い）
✓「dsh-web-ui — DeepSeek Harness の画面を拡張する部品集」

# takeaways（3行で要約）
記事が言っていることを、**その分野を何も知らない人にも通じる言葉で 3 行**書く。

## いちばん大事なこと: 専門用語を使わない
この 3 行は、記事を開くかどうかを決めるためのものではなく、
**開かなくてもその記事の話が分かるためのもの**。だから語彙で足を止めさせない。

- **専門用語・略語・API 名・オプション名・設定名・コマンド名は書かない。**
  普通の言葉に言い換える。名前が知りたい人はカードを開けば要約に出てくる。
- **製品名・サービス名は、主題を特定するのに要るものだけ 1〜2 個まで。**
  それ以外は「あるコード生成ツール」ではなく「文章を書くための道具」のように、
  何をするものかで書く。
- 迷ったら「これを自分の親に読ませて通じるか」を考える。通じないなら言い換える。

✗「MCP サーバーの stdio トランスポートが SSE に置き換わり、後方互換は 1 年維持される」
✓「AI ツールと外部サービスをつなぐ仕組みの通信方式が新しくなった。古い方式も1年は使える。」

✗「Durable Objects の WebSocket Hibernation で 3 つの罠を踏んだ」
✓「常時つなぎっぱなしの通信を安く保つ仕組みには、知らないと詰まる癖が3つある。」

## 読者を主語にしない
読者に呼びかけると、必ず「〜しているなら、〜が参考になる」の形に落ちて、
何も言っていない文になる。**事実の側を主語にする。**

- 「〜するなら」「〜している場合」「自分の」「手元の」で書き出さない
- 「材料になる」「軸になる」「参考になる」「判断材料」「検討価値」「確認できる」
  「押さえておきたい」で終わらせない
- 読者にどう役立つかは書かなくてよい。事実が具体的なら、読者が自分で判断する

✗「Opus を本番で使っているなら、thinking 無効化で 400 エラーになる条件を手元のコードで確認する材料。」
✓「thinking を無効にできるのは effort が high 以下のときだけになった。上の設定のまま上げると 400 で落ちる。」

✗「エージェント設計の現在地を把握し、自分のコードがどの段階にいるかを見直す軸になる。」
✓「エージェントの作り方を Prompt → Context → Harness → Loop → Graph の 5 段階に整理している。上の段ほど自由度が上がり、制御が難しくなる。」

## 3 行の組み立て
**ちょうど 3 項目。1 項目 1 文。句点で終わらせる。**

  ・XXXXXXXX。
  ・OOOOOOO。
  ・AAAAAAA。

**1 項目に読点（、）を使わない。40 字以内。**
読点を挟みたくなったら、それは 1 文に 2 つのことを詰めている合図である。片方を捨てる
（捨てられないなら、それはもう 1 項目ぶんの内容なので、3 項目のどれかと入れ替える）。
PC の幅なら 1 項目が 1 行に収まる長さである（スマホでは 2 行になる）。
ここを超えると 3 項目が 9 行以上になり、「3 行で読み切れる」という約束が崩れる。

✗「AIが書いたコードは見た目は正しく動いても、実は遅かったり危なかったり、保守しにくいことがある。」
　読点 2 つ・49 字。「動く」「遅い」「危ない」「保守しにくい」の 4 つを 1 文に詰めている。
✓「AIが書いたコードは動いてもセキュリティは別問題だった。」（読点なし・28 字）

体言止め・箇条書きの断片（「〜の3つの罠」）にしない。

役割を分けると書きやすい。記事によって順番は変えてよい。
1. **何が起きたか / 何の話か** — 主題を一言で
2. **その中身** — いちばん具体的な一点（数字があるならここ）
3. **だから何が変わるか** — 結果・影響・締切

- **数字は残す。** 前提知識が要らないので、専門外にも効く唯一の具体。
  「大幅に速い」ではなく「1.2 秒から 40ms」、「先月廃止」ではなく「7月31日に廃止済み」。
- 「A だと思われがちだが実は B」「原因は X ではなく Y だった」の形にできるなら、それが一番強い。
- 煽らない。「驚きの」「必見」は禁止。答えを伏せるのも禁止。
- 3 行で同じことを言い換えない。1 行削れるなら、その行には情報が無い。

## 発見が無い記事のとき
入門記事や淡々とした告知には意外性が無い。**無理に作らない。**
何が書いてあるかを率直に書く。3 行に届かないなら 2 行でよい。
記事に書かれていないことを推測で足すのは、この項目で一番やってはいけないこと。

## 完成例
記事: あるサービスのソースマップ公開と API トークン権限の不備を突いた調査記事

✗ 悪い例（記事の語彙をそのまま持ってきている / 読者への指示になっている / 1 項目に 2 文）
　・「.map ファイルから全 TypeScript / React コードが復元できる」
　・「GraphQL / REST の Read-Only トークンで非公開コンテンツを全件取得できる」
　・「この構成を使っているなら、公開設定と Token 権限を今日中に確認すべき」

✓ 良い例（1 項目 1 文・句点で終わる・専門用語なし）
　・「公開されていたファイルから、内部プログラムが丸ごと復元できた。」
　・「読み取り専用のはずの鍵で、下書き記事まで全部取り出せた。」
　・「難読化は数秒で解けたので、防御になっていなかった。」

${LANE_DESCRIBE_BLOCKS[lane]}

# readingMinutes と payoff（時間対効果）
読者が「どれを読むか」を選ぶための材料なので、正直に見積もること。

- readingMinutes は元記事を読み通す時間。抜粋の情報量と記事の型から推定する。
  リリースノートや短い告知は 1〜3 分、通常の技術記事は 5〜10 分、
  詳細な検証記事や長編は 15 分以上。
- payoff は読んだ結果として何が得られるか。
  - apply : 具体的な手順・コマンド・コードがあり、読めば今日の作業に適用できる
  - decide: 比較・検証・設計論で、技術選定や設計判断の材料になる
  - aware : 動向・発表・所感など。今すぐの行動には結びつかないが知っておく価値がある
- 「読めば何かの役に立つはず」で apply にしない。手を動かせる具体物があるときだけ apply。

# durability（どれくらい保つか）
payoff とは別の軸。「今日役に立つか」ではなく「1年後にも意味があるか」で判定する。
判断に迷ったら「この記事を1年後に読み返して、まだ通用するか」を考える。

- foundational : 言語仕様・Web標準・ブラウザの実装・プロトコル・アルゴリズム・
  計算機科学の原理。実装が変わっても知識が残る。数年単位。
  例: TypeScript の型システムの仕組み、Baseline に入った CSS 機能、HTTP/3 の設計
- durable : ライブラリのメジャーバージョンの変更点、アーキテクチャや運用の知見、
  失敗から得られた設計上の教訓。次のメジャー版までは効く。1年程度。
  例: React 19 の破壊的変更、大規模移行の設計判断、障害の事後分析
- ephemeral : 特定ツールの今の使いこなし、現行バージョン限定の回避策、
  「試してみた」「比較してみた」。ツールが更新されれば古くなる。数週間〜数ヶ月。
  例: 特定 CLI のオプションの小技、今のモデルのプロンプトのコツ、料金節約の裏技

- **AI 関連だからといって ephemeral にしない。** 新しいモデルの能力の変化や
  MCP のようなプロトコルの話は durable 以上のことが多い。
  逆に、AI 以外でも「〇〇を導入してみた」の類は ephemeral。
- 有用さと混同しない。今すごく便利な Tips でも、来年通用しないなら ephemeral。`;
}

/**
 * レーンごとに、判定の役に立つ機械的な事実だけを添える。
 *
 * know なら「複数のプラットフォームで同時に取り上げられている」が規模の証拠になり、
 * talk なら「人気の割にコメントが多い」が論争の証拠になる。どちらもモデルが
 * 本文からは読み取れない情報なので、こちらで渡す。build には該当する指標が無い。
 */
function laneEvidence(item: PreScoredItem, lane: Lane): string | null {
  const m = item.metrics;
  switch (lane) {
    case 'know': {
      const parts: string[] = [];
      const sources = item.foundIn?.length ?? 1;
      if (sources > 1) parts.push(`${sources} つのプラットフォームで同時に浮上`);
      if (item.buzz) parts.push('その日として明らかに伸びている');
      return parts.length > 0 ? parts.join(' / ') : null;
    }
    case 'talk': {
      const points = m.points ?? m.likes ?? m.hatena ?? 0;
      const comments = m.comments ?? 0;
      if (comments <= 0) return null;
      // 賛同だけなら star が伸びてコメントは伸びない。割れているとコメント側が伸びる
      return points > 0
        ? `コメント ${comments} 件（支持 ${points} に対して）`
        : `コメント ${comments} 件`;
    }
    default:
      return null;
  }
}

function renderCandidate(
  item: PreScoredItem,
  ref: number,
  excerptChars: number,
  lane: Lane,
): string {
  const excerpt = truncate((item.body || item.snippet).replace(/\s+/g, ' ').trim(), excerptChars);
  // 生の LGTM 数などは渡さない。プラットフォーム間で桁が違って比較できず、
  // モデルが数字の大きいソースに引きずられるため、正規化済みの順位だけを渡す。
  const popularity = `同ソース内で上位 ${Math.round((1 - item.popularityPercentile) * 100)}%`;
  const evidence = laneEvidence(item, lane);

  return [
    `[${ref}] ${item.title}`,
    `  ソース: ${item.sourceLabel} / ${popularity}`,
    item.tags.length ? `  タグ: ${item.tags.slice(0, 8).join(', ')}` : null,
    /*
     * know レーンには関心トピックを渡さない。渡すと「関心に近いから高得点」という
     * 元の偏りがそのまま戻ってくる。このレーンの判定軸は規模であって一致ではない。
     */
    lane !== 'know' && item.matchedTopics.length
      ? `  事前マッチ: ${item.matchedTopics.join(', ')}`
      : null,
    evidence ? `  参考: ${evidence}` : null,
    `  抜粋: ${excerpt || '(本文なし)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 一次情報か。ベストNの枠確保の対象になりうるかの判定に使う */
function isPrimarySource(item: PreScoredItem): boolean {
  return item.source === 'rss' || item.source === 'github_release' || item.source === 'changelog';
}

/** LLM を使わないときのフォールバック値 */
function ruleBasedFields(item: PreScoredItem, lane: Lane, note: string) {
  return {
    // 訳す手段が無いので原題のまま出す（この経路は要約も空なので、画面上も劣化が見える）
    titleJa: null,
    oneLiner: truncate(item.snippet.replace(/\s+/g, ' ').trim(), 80) || item.title,
    takeaways: note ? [note] : [],
    keywords: item.matchedTopics.slice(0, 5),
    category: 'その他',
    lane,
    debate: null,
    // 本文の長さから機械的に見積もる（日本語は約 600 字/分）
    readingMinutes: Math.max(1, Math.min(30, Math.round((item.body?.length ?? 600) / 600))),
    payoff: 'aware' as const,
    // 判定できないので中庸に置く。ephemeral にすると枠確保から機械的に外れてしまう
    durability: 'durable' as const,
  };
}

/** 1 段目: 候補全件にスコアだけ付ける */
async function scorePass(
  b: LlmBackend,
  lane: Lane,
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<Map<string, number>> {
  const batches: PreScoredItem[][] = [];
  for (let i = 0; i < items.length; i += cfg.rankBatchSize) {
    batches.push(items.slice(i, i + cfg.rankBatchSize));
  }

  const system = scoreSystemPrompt(lane, topics, feedbackNote);
  const scores = new Map<string, number>();

  await mapLimit(batches, 3, async (batch, batchIndex) => {
    const offset = batchIndex * cfg.rankBatchSize;
    const body = batch.map((item, i) => renderCandidate(item, offset + i, 500, lane)).join('\n\n');

    try {
      const parsed = await complete(b, {
        stage: `score:${lane}`,
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

/**
 * 要約 1 リクエストあたりの件数。
 * 出力が大きい段なので、採点（18件）より小さく刻む。
 */
const DESCRIBE_BATCH_SIZE = 12;

/** 2 段目: 実際に保存する分だけ文章化する */
async function describePass(
  b: LlmBackend,
  lane: Lane,
  shortlist: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<Map<string, DescribeItem>> {
  const described = new Map<string, DescribeItem>();
  if (shortlist.length === 0) return described;

  /**
   * 採点と同じくバッチに割る。
   *
   * 1 回にまとめると出力が max_tokens を超えて JSON が途中で切れ、
   * その回の全件が失われる（本番で 0/42 件になった）。1 件あたり
   * 要約・読みどころ・キーワードで 400〜500 トークン使うので、
   * 12 件で 6,000 前後。max_tokens は倍以上を確保しておく。
   * 分けておけば、1 バッチが落ちても残りは生き残る。
   */
  const batches: PreScoredItem[][] = [];
  for (let i = 0; i < shortlist.length; i += DESCRIBE_BATCH_SIZE) {
    batches.push(shortlist.slice(i, i + DESCRIBE_BATCH_SIZE));
  }

  const system = describeSystemPrompt(lane, topics, feedbackNote);
  // talk レーンだけ「意見の足場」の 5 項目が乗る。他のレーンで無駄な出力をさせない
  const schema = lane === 'talk' ? TalkDescribeResultSchema : DescribeResultSchema;
  await mapLimit(batches, 3, async (batch, batchIndex) => {
    // ref は採点段と同じく通し番号で振る（実装が食い違うと取り違えの温床になる）
    const offset = batchIndex * DESCRIBE_BATCH_SIZE;
    const body = batch.map((item, i) => renderCandidate(item, offset + i, 700, lane)).join('\n\n');
    try {
      const parsed = await complete(b, {
        stage: `describe:${lane}`,
        model: cfg.rankModel,
        maxTokens: 16000,
        system,
        prompt: `以下 ${batch.length} 件を要約してください。\n\n${body}`,
        schema,
      });
      for (const r of parsed.items ?? []) {
        const item = shortlist[r.ref];
        if (item) described.set(item.id, r as DescribeItem);
      }
    } catch (err) {
      log.warn(`要約 ${lane} batch ${batchIndex}: ${err instanceof Error ? err.message : err}`);
    }
  });

  return described;
}

/**
 * 見出しに出す日本語のタイトルを決める。
 *
 * 置き換えるのは「原題が日本語として読めないとき」だけにする。原題が日本語なら
 * それが一番正確な題で、要約で書き換えると情報が落ちるだけである。
 *
 * モデルの出力も仮名の有無で検算する。英語のタイトルをそのまま写して返すことが
 * あり（原題が日本語かどうかの判断はモデル側でも間違える）、それを採用すると
 * 「日本語の見出しを入れた」つもりで英語が残る。訳せていないものは捨てて、
 * 原題を出す方に倒す——英語の原題のほうが、中途半端な見出しよりは読める。
 */
function pickTitleJa(item: PreScoredItem, raw: string | null | undefined): string | null {
  if (hasKana(item.title)) return null;
  const titleJa = raw?.replace(/\s+/g, ' ').trim();
  if (!titleJa || !hasKana(titleJa)) return null;
  return titleJa;
}

/**
 * 要約結果から「意見の足場」を組み立てる。
 *
 * 争点が本当に無い記事に無理やり争点をかぶせるのが一番まずいので、
 * 軸か賛成側か反対側のどれかが欠けていたら、まるごと null にして表示しない。
 * 半端な足場は、無い足場より読者を迷わせる。
 */
function toDebate(r: DescribeItem): Debate | null {
  const axis = r.debateAxis?.trim();
  const forSide = r.debateFor?.trim();
  const againstSide = r.debateAgainst?.trim();
  if (!axis || !forSide || !againstSide) return null;
  return {
    axis,
    forSide,
    againstSide,
    oneSided: r.debateOneSided === true,
    yourAngle: r.debateYourAngle?.trim() || '',
  };
}

/**
 * レーンごとに採点し、そのレーンのラベルを付けた RankedItem を返す。
 *
 * レーンをまたいだ重複は起きない。候補の割り当て（lanes.ts）の時点で
 * 1 件は 1 レーンにしか入らないため、ここでは単純に連結すればよい。
 * score はレーン内でのみ意味を持つ値になる——know の 80 点と talk の 80 点は
 * 別の問いへの答えなので、レーンをまたいで並べ替えてはいけない。
 */
export async function rankItems(
  byLane: Record<Lane, PreScoredItem[]>,
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<RankedItem[]> {
  const b = await getBackend();
  if (!b) {
    log.warn('LLM バックエンドが無いためルールベースのスコアにフォールバックします');
    return LANES.flatMap((lane) =>
      byLane[lane].map((item) => ({
        ...item,
        score: Math.round(item.preScore * 100),
        ...ruleBasedFields(item, lane, '事前スコアのみ（LLM 未使用）'),
      })),
    );
  }

  const perLane = await Promise.all(
    LANES.map((lane) => rankLane(b, lane, byLane[lane], topics, cfg, feedbackNote)),
  );
  return perLane.flat();
}

/** 「3行で要約」1 項目の上限。これを超えると画面で 1 行に収まらない */
const TAKEAWAY_CHAR_BUDGET = 40;

/**
 * 予算を超えた「3行で要約」を実行ログに出す。
 *
 * 切り詰めはしない——文の途中で切ると読めなくなるし、ここは読者が最初に読む場所である。
 * 一方で黙って通すと「3 行で読み切れる」という約束だけが静かに崩れる。
 *
 * 字数の指示はモデルが守りきれない（実測で中央値 43 字・最大 84 字だった日がある）。
 * だからプロンプト側は字数ではなく「読点を使わない」という数えられる制約に寄せてあり、
 * ここでは結果として守れているかを毎回ログに出す。
 */
function warnLongTakeaways(lane: Lane, described: Map<string, DescribeItem>): void {
  let over = 0;
  let total = 0;
  let longest = 0;
  for (const r of described.values()) {
    for (const line of r.takeaways ?? []) {
      total++;
      const n = line.trim().length;
      longest = Math.max(longest, n);
      if (n > TAKEAWAY_CHAR_BUDGET) over++;
    }
  }
  if (over === 0 || total === 0) return;
  log.warn(
    `  [${LANE_LABELS[lane]}] 3行で要約が長すぎます: ${over}/${total} 項目が ` +
      `${TAKEAWAY_CHAR_BUDGET} 字超（最長 ${longest} 字）`,
  );
}

/**
 * 2 段目（要約）に回す候補を選ぶ。
 *
 * **不変条件: ベスト N に選ばれうる項目は、必ずここに入っていること。**
 * 要約されなかった項目がベストに選ばれると、ルールベースの値で埋められる——
 * 3 行要約もキーワードも空、カテゴリは「その他」——のに、画面上はカードとして
 * 成立してしまう。ログを見ないと気づけない壊れ方なので、選抜側の到達範囲を
 * ここで先回りして覆っておく。
 *
 * 覆うべき経路は 2 つある。どちらも「スコア順の上位 n 件」の外に出る。
 * 1. 枠確保（一次情報・長く効くもの・今日試せるもの）
 * 2. 「1 ソース 1 件」の多様化
 */
export function describeShortlist<T extends PreScoredItem>(
  items: readonly T[],
  scoreOf: (item: T) => number,
  topN: number,
  otherN: number,
): T[] {
  const byScore = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const laneOtherN = Math.ceil(otherN / LANES.length);
  const base = byScore.slice(0, topN + laneOtherN + 6);
  const taken = new Set(base.map((i) => i.id));
  const extra: T[] = [];

  const add = (list: readonly T[]) => {
    for (const i of list) {
      if (taken.has(i.id)) continue;
      taken.add(i.id);
      extra.push(i);
    }
  };

  // 枠確保でスコア順の外から拾われる分
  add(byScore.filter(isPrimarySource).slice(0, topN + 2));

  /*
   * 「1 ソース 1 件」の多様化が到達しうる分。
   *
   * 上位が同じソースで埋まっている日、多様化はスコア順のずっと下から拾う。実測で
   * 話すレーンの上位 5 件が全部 Qiita だった日に 6 番目（60 点）が繰り上がり、
   * それが base に入っていなかったため要約されず、3 行要約が空のカードが出た。
   * 多様化が触れるのは各ソースの最上位だけなので、先頭から topN ソース分を足す。
   */
  add(pickTopDiverse(byScore.map((i) => ({ ...i, score: scoreOf(i) })), topN) as T[]);

  return [...base, ...extra];
}

async function rankLane(
  b: LlmBackend,
  lane: Lane,
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<RankedItem[]> {
  if (items.length === 0) return [];

  // 1 段目
  const scores = await scorePass(b, lane, items, topics, cfg, feedbackNote);
  log.info(`  [${LANE_LABELS[lane]}] スコアリング: ${scores.size}/${items.length} 件`);

  const scoreOf = (item: PreScoredItem) =>
    // 採点に失敗した分は事前スコアで代替する（控えめに）
    scores.get(item.id) ?? Math.round(item.preScore * 60);

  /**
   * 2 段目に回す候補。
   *
   * 単純なスコア上位だけでは足りない。ベスト N は一次情報や長く効くものの枠を
   * 確保するため、スコア順の外から拾うことがある。要約されていない項目が
   * 選ばれると、要約が本文の切り出しになり durability も既定値になる
   * （判定していないのに枠を満たしてしまう）。その分だけ候補を広げておく。
   */
  const shortlist = describeShortlist(items, scoreOf, cfg.topN, cfg.otherN);

  const described = await describePass(b, lane, shortlist, topics, cfg, feedbackNote);
  log.info(`  [${LANE_LABELS[lane]}] 要約: ${described.size}/${shortlist.length} 件`);
  warnLongTakeaways(lane, described);

  const result = items.map((item) => {
    const r = described.get(item.id);
    const score = scoreOf(item);
    if (!r) {
      return {
        ...item,
        score,
        ...ruleBasedFields(item, lane, scores.has(item.id) ? '' : '採点失敗'),
      };
    }
    return {
      ...item,
      score,
      titleJa: pickTitleJa(item, r.titleJa),
      oneLiner: r.oneLiner?.trim() || item.title,
      takeaways: clean(r.takeaways).slice(0, 3),
      keywords: (r.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
      category: CATEGORIES.includes(r.category) ? r.category : 'その他',
      lane,
      debate: lane === 'talk' ? toDebate(r) : null,
      readingMinutes: Number.isFinite(r.readingMinutes)
        ? Math.max(1, Math.min(30, Math.round(r.readingMinutes)))
        : 5,
      payoff: PAYOFFS.includes(r.payoff) ? r.payoff : 'aware',
      durability: DURABILITIES.includes(r.durability) ? r.durability : 'durable',
    };
  });

  warnMissingTitleJa(lane, shortlist, result);
  return result;
}

/**
 * 日本語の見出しが付かなかった候補を実行ログに出す。
 *
 * 掲載されうるのは要約対象（shortlist）だけなので、母数はそこに限る。
 * 付かなかった項目は英語のタイトルのまま画面に出る——落ちずに劣化する形なので、
 * 何件そうなったかをここで見えるようにしておく。
 */
function warnMissingTitleJa(lane: Lane, shortlist: PreScoredItem[], ranked: RankedItem[]): void {
  const ids = new Set(shortlist.map((i) => i.id));
  const foreign = ranked.filter((i) => ids.has(i.id) && !hasKana(i.title));
  if (foreign.length === 0) return;
  const done = foreign.filter((i) => i.titleJa).length;
  log.info(`  [${LANE_LABELS[lane]}] 日本語の見出し: ${done}/${foreign.length} 件`);
  if (done < foreign.length) {
    log.warn(
      `  [${LANE_LABELS[lane]}] ${foreign.length - done} 件は英語のタイトルのまま出ます: ` +
        foreign
          .filter((i) => !i.titleJa)
          .map((i) => i.title.slice(0, 40))
          .join(' / '),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 2) 深掘り要約（高性能モデル）
 * ------------------------------------------------------------------ */

/**
 * カードをどの目的で読ませるか。同じ記事でも、レーンが違えば書くべき中身が違う。
 * 一覧側の要約（describe）と食い違わないよう、判定の問いは採点基準と同じものを使う。
 */
const LANE_DEEP_BLOCKS: Record<Lane, string> = {
  know: `# このカードの目的:「知る」
これは規模の大きい話として選ばれている。読者が知りたいのは使い方ではなく、
**自分がどう巻き込まれるか** である。手順を書く項目も「試す」ではなく「確認する」に寄せる。

**このレーンの箇条書きは、読み物ではなく一覧表として書く。**
誰に・いつから・何をするか、を目で拾えることが価値なので、
1 項目 1 行で、条件と日付と動作だけを置く。理由や背景は summary の仕事である。

- **impact**（画面では「関係がある人」）— **「〜な人」の形で淡々と列挙する。
  2〜4 個、各 30 字以内。** 読者が自分が該当するかを目で拾うためだけの一覧なので、
  影響の内容も理由も書かない。「〜なので」「〜のため」「〜になる」が入ったら書きすぎで、
  それは summary の仕事である。
  ✗「many-ai-cli に OpenRouter 対応を追加・検討している開発者が対象。OpenRouter は独立した
  　7 つ目の CLI／プロバイダではなく、Ollama と同じ既存 CLI の backend として扱う設計になる。」
  ✓「many-ai-cli に OpenRouter を足そうとしている人」
  ✓「厳密な JSON 抽出をしている人」
  「広く影響する」で済ませない。特定できないなら「範囲不明」の 1 項目だけにする。
- **timeline** — **日付が本体の情報だけ。1 行・40 字以内。0〜3 個。**
  「2026-08-31 サポート終了」のように、日付＋出来事だけを置く。
  **報道・資金調達・買収協議の経緯は書かない。** 読者の期限（いつから効くか、
  いつまでに動くか）だけを拾う。時期の記述が無ければ空配列。
- **checkNow** — 読者がいま取るアクション。**1 行・60 字以内。2〜3 個。**
  打てるコマンド、開く設定ファイル名、暫定の回避策まで具体化する。
  「注意する」「確認しておく」のように、何をするか決まらない書き方は禁止。
- **unknowns** — 進行中の事象なら、判明していることと推測の境目を書く。
  **1 行・40 字以内。0〜3 個。** ここを空にしたまま推測を impact に混ぜるのが、
  このレーンで一番まずい。
- 同じ事実を impact と timeline と unknowns に三重に書かない。
  未確定なら unknowns にだけ書く。
- 図は、事故の経緯や移行のスケジュールのように時間の前後があるものなら flow、
  どこを通って何が漏れた・何が影響を受けるという経路の話なら architecture が合う。`,

  build: `# このカードの目的:「作る」
これは試してみたくなるものとして選ばれている。読者はこのカードを読んで、
そのまま手を動かし始める。

# このカードの中心の問い
**「読んだ人が『そんなことができるのか、試したい』と思うか」**

**仕組みの解説を書く場所ではない。** 仕組みが分かっても手は動かない。動くのは、
自分の手元で何が起きるかが**絵として浮かんだ**ときである。だから unlocks は
機能の列挙ではなく、読者が思い描ける一点にする。

そのうえで「これは自分に関係があるか」「関係があるなら、どう始めるか」に答える。
判定と手順が埋もれると、面白そうでも結局試されない。

- **unlocks** — **読んだ人が「試したい」と思う一点。1〜2 個、各 45 字以内。**
  **目に浮かぶ具体で書く。** 読者が頭の中で動いている絵を思い描けなければ失敗である。
  ✓「録画を投げると、話者ごとに分けた字幕がそのまま返ってくる」（絵が浮かぶ）
  ✗「音声処理をパイプライン経由の話者分離モジュールにも型付きで開放できる」
  　（仕組みの説明。何が嬉しいのか浮かばない）

  **例はあくまで書き方の見本である。** 記事の内容に置き換えて書くこと——
  見本の題材をそのまま流用してはいけない。
  **仕組みの名前を主語にしない。読者が何をできるかを主語にする。**
  「速くなる」「便利になる」「効率化できる」は程度の改善であって、
  できるようになることではない。
  **付随的な機能を並べない。** 2 個目を書くなら、1 個目と種類が違うことだけ。
  本当に新しくできることが無い記事なら、何が楽になるのかを 1 つだけ率直に書く。盛らない。
- **fitFor / notFor**（画面では「使える場面 / 向かない場面」）— **読者が自分の環境を見て
  YES / NO で即答できる条件**を書く。人物像を書くと、誰にでも当てはまって判定に使えない。
  ✗「効率化したい開発者に向いている」「本格的な用途には向かない」（判定できない）
  ✓「CI のビルドが 5 分を超えているとき」
  ✓「Windows で動かすとき（未対応）」
  ✓「月 1 万リクエスト未満なら手作業のままでよい」
  notFor には、使えない（未対応）ものと、使えるが不適なものの両方を入れてよい。
  書いたあと 1 項目ずつ、「読者はこれに YES / NO で答えられるか」を確認する。
  答えられないものは書き直すか落とす。各 50 字以内、それぞれ 1〜3 個。
- **howToTry** — インストールから最初の結果が出るまでを、読者が調べ直さずに済む粒度で。
  **1 個目は必ずコピペで実行できる 1 行にする**（インストールコマンド、
  クローン、\`npx\` の一撃）。読者が最初に踏む段を、判断ではなく貼り付けにする。
  記事にコマンドが無いなら、公式の入手先 URL を 1 個目に置く。
- **tryPrompt** — **「試し方」を、そのままコーディングエージェント（Claude Code など）に
  貼って試し始められるプロンプトの形で書く。** 読者はこれをコピーして、自分の端末か
  クラウドの Linux 環境に貼る。人が横にいるので、人間しかできない手順（サインアップ、
  GUI の操作）は禁じない——末尾に「（手動）」を付けて書く。
  次の 4 節を、この見出し・この順で必ず書く（見出しは行頭に \`# \`）:
  \`# 試すこと\` 1 行の目標。次の行に元の URL
  \`# 手順\` 番号付き。1 行 1 コマンドか 1 動作。コマンドはそのまま打てる形
  \`# 確認したいこと\` やってみないと分からないことだけ、1〜3 個。
    ✗「何ができるツールか」（記事に書いてある）
    ✓「README の 3 ステップだけで最初の出力まで到達できるか」
  \`# 前提・注意\` 必要な環境（OS・鍵・別ツール）、記事本文でコマンドが欠けている等。
    無ければ「- 特になし」
  全体で 1,200 字以内。**動かす対象そのものが無い記事（設計論・体験記・ニュース）なら null。**
- **caveats** — **最重要の 1 つだけ。0〜1 個、50 字以内。**
  次のどれかに当たるもののうち、**いちばん起こりやすく損害が大きい 1 つ**を選ぶ:
  (1) 知らずに始めると詰まる前提（別ツールの導入、未対応の環境）
  (2) 想定外にお金がかかる (3) データや既存の設定が壊れる。
  **仕様の細部はここに書かない。**
  ✗「style: react は動作するが非推奨警告あり、将来的に reactcore への移行が必要」
  ✗「dcp の上限はモデル構造依存: GQA は KV ヘッド数まで、MLA は TP と同数まで」
  　（どちらも仕様の説明であって、知らずに始めて困ることではない。
  　　そういう情報は「使える場面 / 向かない場面」か「試し方」の側に属する）
  ✓「Node.js 22.13 未満だとローカル起動の時点でつまずく」
  ✓「通信は HTTPS 経由だがエンドツーエンドでは暗号化されない」
  「まだ新しいので注意」「本番利用は慎重に」のような、どの新しい道具にも言える
  一般論も書かない。該当が無ければ空配列にする——**埋めるために書かない。**
- 図は、何をどこに差すかという構成なら architecture、動く順序なら flow、
  記事に実測値があるなら metrics。`,

  talk: `# このカードの目的:「話す」
これは読者が自分の意見を発信するための素材として選ばれている。
**意見の下書きを書かないこと。** 読者自身の言葉で書けるための材料だけを渡す。

# このカードの中心の問い
**「この争点に、読者は自分の経験から何を足せるか」**

両側の言い分が分かっても、人は発信しない。それで得られるのは「詳しくなった」状態である。
発信が起きるのは、**自分の手元にある事実がこの議論の材料になると気づいた瞬間**。
「賛成です」「反対です」は誰でも書けて、投稿する価値が無い。

- **clashes** — 争点を論点ごとに分解し、**「こう言われる（claim）／こう返せる（counter）」を
  対で**書く。2〜3 組。
  **claim と counter は必ず噛み合わせること。** ここがこの項目の全部である。
  ✗ claim「ボトルネックは実装ではなく境界の設計」/ counter「ハルシネーションは完全になくならない」
  　（別の話をしている。読者は対応づけられない）
  ✗ counter に、記事と同じ立場の補強を書く（反論になっていない）
  ✓ claim「ボトルネックは実装ではなく境界の設計」/ counter「境界を先に固めても、
  　公開 API や DB 移行の変更コストは下がらない」
  記事からの引用を長く貼らない。各 50 字で、自分の言葉に詰めること。
  **成り立つ条件・崩れる条件は独立した項目にせず、この対の中に入れる**
  （「小規模なら前者、CI が遅いチームなら後者」）。賛否の本質は正誤ではなく
  優先順位の違い（速さ vs 安全、自動化 vs 制御）なので、その分かれ目が対の中に出る。
  反対側が記事に書かれていないなら counterInArticle を false にする。
- **firsthand** — **この項目が中心の問いに直接答える。**
  読者が自分の経験からこの争点に足せることを、**切り口（angle）と、なぜ読者が
  それを言えるのか（why）の対で**書く。1〜3 組。
  angle は**名詞句だけ。文にしない。主張を書かない。**
  ✗「レビューの自動化には慎重であるべきだ」（意見の代筆になっている）
  ✓「生成量とレビュー負荷の実測」「見逃し率3倍という数字の測定条件」
  why は、読者プロフィールにある技術・立場・日常の作業と結びつける。
  ✓「同じ構成を業務で毎日動かしているので、手戻りの頻度を実測値として出せる」
  **切り口だけを渡してはいけない。** 発信の最大の障壁は「これを自分が言っていいのか」で、
  それに答えるのは why の側である。接点が本当に無ければ空配列にする。ひねり出さない。
- **verify** — 読者が自分の環境で真偽を確かめる方法。0〜2 個。無ければ空配列。
- 図は、賛成側と反対側の対比なら comparison。ただし clashes と同じ内容になるなら null。`,
};

function deepSystemPrompt(lane: Lane, topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
1本の記事を読み込み、「朝の30分で要点を掴んで、必要なら今日すぐ試せる」カードに変換してください。

# 読者プロフィール
${topics.profile}

${LANE_DEEP_BLOCKS[lane]}

# 執筆ルール
- すべて日本語。ただし API 名・オプション名・コマンドは原文のまま正確に書く。
- 記事に書かれていないことを推測で書かない。情報が無い項目は空配列にするか、その旨を明記する。
- 「〜が発表されました」で終わらせない。読者の手元で何が起きるかまで踏み込む。
- 手順を書く項目は、実際に打てるコマンド・書けるコードのレベルまで具体化する。「試してみましょう」は禁止。
- バージョン番号、フラグ名、デフォルト値の変更は省略せず正確に書く。
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

## 件数は網羅側に倒す
**足りないより多い方がよい。** 読者はこのカードを畳んだまま飛ばせるし、
気になった語だけ開いて読める。一方、説明が無い語は詰まったまま残る。

- **4〜8 項目**を目安にする。詰まる箇所が多い記事なら 8 まで出してよい。
- 「これは説明が要るか、要らないか」で迷ったら**入れる**。
- ただし、記事に出てこない語を持ち出さない。埋めるための水増しはしない。
- 本当に詰まる箇所が無い記事（読者の専門分野そのもの、平易な入門記事）なら空配列でよい。

## term は「このカードで自分が書いた語」にする
画面では、**このカードの summary・箇条書き・whyItMatters に出てくる語**に
その場で開ける印を付ける。だから term は、自分がそれらの文章の中で
実際に使った語と一字一句そろえること。そろっていないと印が付かない。

- **短い名詞か識別子にする。25字以内。文にしない。**
  ✗ 'organization-level model settings no longer apply'（文）
  ✗ 'BashOutput / KillBash 相当'（「相当」は自分で足した語）
  ✗ '無駄なやり取り(ターン)/トークンの無駄遣い'（説明であって語ではない）
  ✓ 'run_in_background'  ✓ 'x-robots-tag'  ✓ 'least-restrictive strategy'
- **その語を summary か箇条書きの中で必ず一度使う。** 説明が要ると判断した語なら、
  本文中で触れずに脚注だけ置くのは筋が通らない。
- 記事側の表記をそのまま使う。言い換えない（router.refresh() を「Next の refresh 関数」にしない）。

# visual（図）の選び方

## 先に「何を図にするか」を決める。形式は後から選ぶ
図にするのは、**記事のいちばん重要な構造**であって、書きやすい部分ではない。
順番を逆にすると、大事でないところが図になる。まず次を自問する。

**「この記事で、文章だと読み取りにくいものは何か」**

- 事故・障害の記事 → 何が起きて何が漏れたかの**経緯**（時間の順序）
- 仕組みや構成の記事 → どこからどこへデータや処理が流れるかの**経路**
- 変更・移行の記事 → 変更前と変更後の**対比**
- 性能改善の記事 → 記事に書かれている**実測値**

## 箇条書きの言い換えは図ではない
**上の箇条書き（impact / unlocks / evidence など）に書いたことを表に組み替えただけなら、
図を作らずに null にする。** これが一番多い失敗で、読者は同じ内容を 2 回読むことになる。
書き終えたら、図の各行が箇条書きのどれかと同じことを言っていないか照合する。

## 形式の選び方
- **architecture** — **何がどこを経由してどこへ届くか。** 登場するものが 3 つ以上あって、
  それらの間に「呼ぶ / 経由する / 差し替える」の関係があるならこれ。
  上から下へ 2〜4 層に積み、**層と層の間に「何が渡るか」（via）を書く。**
  層は「呼ぶ側 → 経由するもの → 実体」の順にする。
  記事が論じている当のものに highlight を立てて、「この記事は構成のどこの話か」を示す。
  例: 自作 CLI → 既存 CLI（via: OpenAI 互換 API）→ 中継サービス（via: 従量課金）→ 各社のモデル
  **層の中の並び順には意味がある。** 画面では層をまたいで同じ位置が縦に揃うので、
  n 番目には上の層の n 番目から繋がるものを置く。経路が 2 本ある構成なら、
  左の列で 1 本・右の列で 1 本の経路になるように並べる。1 本しかない層は 1 個だけにする。
- **flow** — **時間の順序があるもの。** 事故が起きた経緯、移行のスケジュール、手順。
  「同時に存在するものの配置」は時間ではないので architecture を使う。
- **comparison** — 二つの状態の対比。変更前と変更後、賛成側と反対側。
  **「観点ごとの一覧表」を作るために使ってはいけない**（それは箇条書きの言い換え）。
- **metrics** — 記事に実際の数値が書かれている場合のみ。数値を推測で作らない。
- どれも当てはまらない、または図にしても情報が増えないなら null。無理に図を作らない。

# figures（記事の画像の引用）

本文に画像があった記事では、候補が「記事の中の画像」として番号付きで渡される。
そのうち**解説の中で引用する価値があるものだけ**を選ぶ。**既定は引用しない（空配列）。**

引用するのは、**文章にするより画像のほうが早いもの**だけ。

- 実行結果・UI のスクリーンショット（何がどう見えるかは文章で書き起こしても伝わらない）
- 書き手が描いた構成図・フローの図解（自分で visual を作るより、記事の図のほうが正確）
- 計測結果のグラフ（数値の推移は形で見るほうが早い）

引用しないもの。**迷ったら引用しない。**

- アイキャッチ、人物写真、記事の内容と関係のないイラスト（面積を使って情報が増えない）
- 文字を大きく描いただけの画像（読めばよい）
- 自分が書いた visual と同じことを示している画像（どちらか一方でよい。記事の図が正確なら visual を null にして画像を引用する）
- 何が写っているか、渡された alt と前後の本文から判断できないもの（当てずっぽうで説明を付けない）

caption は**その画像から何が読み取れるか**を書く。読者は画像を見る前にキャプションを読むので、
「何の画像か」ではなく「どこを見ればいいか」を渡す。
✗「新しい設定画面のスクリーンショット」（見れば分かることしか書いていない）
✓「上段が従来の並び。モデル選択が展開済みになり、既定が sonnet から opus に変わっている」`;
}

/**
 * 本文中の画像の候補を、番号付きで LLM に渡す形にする。
 *
 * 本文は素のテキストに落としてから渡しているので、画像の位置は本文からは分からない。
 * 代わりに alt と画像の前後の本文（▮ が画像の位置）を添えて、記事のどこの図なのかを
 * 判断できるようにしている。URL は渡さない——選ぶのは番号だけにして、
 * 存在しない URL を書けないようにするため。
 */
function figureCandidateBlock(bodyImages: readonly BodyImage[]): string {
  if (bodyImages.length === 0) return '';
  const lines = bodyImages.map(
    (img, i) =>
      `[画像${i + 1}] alt: ${img.alt || '(なし)'}\n  前後の本文（▮ が画像の位置）: ${img.context || '(取れなかった)'}`,
  );
  return `\n\n--- 記事の中の画像ここから ---\n${lines.join('\n')}\n--- 記事の中の画像ここまで ---`;
}

export async function deepDive(
  item: RankedItem,
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  bodyImages: readonly BodyImage[] = [],
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
    /*
     * 一覧側で既に書かせた争点を渡す。カード側で別の軸を立てると、
     * 同じ記事について画面の上下で違うことを言うことになる。
     */
    item.debate ? `一覧で提示済みの争点: ${item.debate.axis}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const content = truncate(item.body || item.snippet, cfg.bodyCharLimit);
  const request = {
    stage: `deep:${item.lane}`,
    model: cfg.summaryModel,
    maxTokens: 12_000,
    effort: cfg.summaryEffort,
    system: deepSystemPrompt(item.lane, topics),
    prompt:
      `${meta}\n\n--- 本文ここから ---\n${content}\n--- 本文ここまで ---` +
      figureCandidateBlock(bodyImages),
  };

  try {
    // スキーマはレーンごとに違うので、分岐したうえで呼ぶ（union のままだと型が絞れない）
    switch (item.lane) {
      case 'know': {
        const p = await complete(b, { ...request, schema: KnowDeepDiveSchema });
        return {
          ...toBase(p, item, bodyImages),
          lane: 'know',
          impact: clean(p.impact),
          timeline: clean(p.timeline),
          checkNow: clean(p.checkNow),
          unknowns: clean(p.unknowns),
        };
      }
      case 'build': {
        const p = await complete(b, { ...request, schema: BuildDeepDiveSchema });
        return {
          ...toBase(p, item, bodyImages),
          lane: 'build',
          unlocks: clean(p.unlocks),
          howToTry: clean(p.howToTry),
          fitFor: clean(p.fitFor),
          notFor: clean(p.notFor),
          caveats: clean(p.caveats),
          tryPrompt: sanitizeTryPrompt(p.tryPrompt),
        };
      }
      case 'talk': {
        const p = await complete(b, { ...request, schema: TalkDeepDiveSchema });
        return {
          ...toBase(p, item, bodyImages),
          lane: 'talk',
          /*
           * 片側だけの対は噛み合いにならないので落とす。半端な対は、
           * 無い対より読者を迷わせる（一覧の debate を丸ごと null にするのと同じ判断）。
           */
          clashes: (p.clashes ?? [])
            .filter((c) => c?.point?.trim() && c?.claim?.trim() && c?.counter?.trim())
            .map((c) => ({
              point: c.point.trim(),
              claim: c.claim.trim(),
              counter: c.counter.trim(),
              counterInArticle: c.counterInArticle === true,
            })),
          /*
           * 角度は名詞句だけにさせている。文で返ってきたものは意見の代筆なので落とす。
           * why は逆に文でよい（読者自身の状況の説明であって、主題への意見ではない）。
           */
          firsthand: (p.firsthand ?? [])
            .filter((f) => f?.angle?.trim() && f?.why?.trim())
            .filter((f) => !looksLikeOpinion(f.angle.trim()))
            .map((f) => ({ angle: f.angle.trim(), why: f.why.trim() })),
          verify: clean(p.verify),
        };
      }
    }
  } catch (err) {
    log.warn(`深掘り失敗 (${item.title}): ${err instanceof Error ? err.message : err}`);
    return fallbackDeepDive(item);
  }
}

/** 3 レーン共通の項目を整える */
function toBase(
  parsed: KnowDeepDiveResult | BuildDeepDiveResult | TalkDeepDiveResult,
  item: RankedItem,
  bodyImages: readonly BodyImage[],
) {
  return {
    summary: parsed.summary?.trim() || item.oneLiner,
    prerequisites: (parsed.prerequisites ?? [])
      .filter((p) => p?.term && p?.explanation)
      .map((p) => ({ ...p, stumblingPoint: p.stumblingPoint ?? '' })),
    visual: normalizeVisual(parsed.visual as DeepDive['visual']),
    figures: pickFigures(parsed.figures, bodyImages),
    code: parsed.code ?? null,
    relatedLinks: (parsed.relatedLinks ?? []).filter((l) => l?.url?.startsWith('http')),
    readingMinutes: Number.isFinite(parsed.readingMinutes)
      ? Math.max(1, Math.min(30, Math.round(parsed.readingMinutes)))
      : 5,
  };
}

/**
 * 引用する画像を確定する。
 *
 * URL は候補側から取る。LLM が返すのは番号だけなので、候補に無い画像が画面に出ることはない
 * ——番号を間違えたら、その 1 枚が落ちるだけで済む。存在しない番号・説明の無いものは落とす。
 */
function pickFigures(
  chosen: { index: number; caption: string }[] | undefined,
  bodyImages: readonly BodyImage[],
): Figure[] {
  const out: Figure[] = [];
  const used = new Set<string>();
  for (const pick of chosen ?? []) {
    if (out.length >= MAX_BODY_IMAGES) break;
    const source = bodyImages[Math.round(pick?.index ?? 0) - 1];
    const caption = pick?.caption?.trim();
    if (!source || !caption || used.has(source.url)) continue;
    used.add(source.url);
    out.push({ url: source.url, alt: source.alt, caption });
  }
  return out;
}

/** 空文字と余白だけの項目を落とす。箇条書きに空行が出るのを防ぐ */
function clean(list: string[] | undefined): string[] {
  return (list ?? []).map((v) => v?.trim()).filter((v): v is string => Boolean(v));
}

/**
 * 「語れる角度」が主張になっていないか。
 *
 * 角度は読者が自分の言葉で書き始めるための見出しなので、名詞句でなければならない。
 * 文を渡すと読者はそれをそのまま投稿でき、裏を取っていない意見が本人の名前で外に出る。
 * プロンプトでも禁じているが、破られたときに画面まで通さないようにする。
 */
/**
 * 文で返ってきた「角度」を弾く。
 *
 * 名詞句だけを並べさせているのに、モデルは文を書きたがる。文になったものは
 * 意見の代筆なので落とす。コミュニティの「あなたが出せる題材」も同じ思想なので、
 * community.ts から共有している（判定を二重に持つと片方だけ緩む）。
 */
export function looksLikeOpinion(text: string): boolean {
  return /[。.]$/.test(text) || /べき|だと言える|と思う|しよう|ではないか/.test(text);
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
    case 'architecture': {
      const layers = (visual.layers ?? [])
        .map((l) => ({ ...l, nodes: (l.nodes ?? []).filter((n) => n?.name) }))
        .filter((l) => l?.label && l.nodes.length > 0);
      // 1 層だけのものは構成ではない（要素の並びを層と呼んでいるだけ）
      if (layers.length < 2) return null;
      return { ...visual, layers };
    }
    default:
      return null;
  }
}

/**
 * 深掘りに失敗した日の代替。
 *
 * 項目を埋められないので抜粋だけを出し、caveats 相当の場所で「要約に失敗した」と
 * 明示する。もっともらしい空の箇条書きを並べるより、失敗が見えるほうがよい。
 */
function fallbackDeepDive(item: RankedItem): DeepDive {
  const base = {
    summary: truncate((item.body || item.snippet).replace(/\s+/g, ' ').trim(), 500),
    prerequisites: [],
    visual: null,
    figures: [],
    code: null,
    relatedLinks: [],
    readingMinutes: 5,
  };
  const failed = 'LLM による要約に失敗したため、抜粋のみ表示しています。';

  switch (item.lane) {
    case 'know':
      return { ...base, lane: 'know', impact: [], timeline: [], checkNow: [], unknowns: [failed] };
    case 'build':
      return {
        ...base,
        lane: 'build',
        unlocks: [],
        howToTry: ['元記事を開いて確認してください。'],
        // 要約に失敗した記事は、何を試すのかも決まっていない。箱は出さない
        tryPrompt: null,
        fitFor: [],
        notFor: [],
        caveats: [failed],
      };
    case 'talk':
      return { ...base, lane: 'talk', clashes: [], firsthand: [], verify: [] };
  }
}

/* ------------------------------------------------------------------ *
 * 3) 冒頭サマリー
 *
 * ベスト N・リリース情報・その他の注目記事が出揃った後、それらを material に
 * その日の技術界隈の傾向を俯瞰したインサイトを書く。個々の記事の紹介の
 * 抜粋・列挙ではなく、「今日はセキュリティ関連が多かった」のような、
 * 複数項目を束ねて初めて見える傾向を渡す。すでに要約済みの
 * headline/oneLiner/summary/category/lane から合成するだけなので、
 * 安い rankModel で足りる。
 * ------------------------------------------------------------------ */

const RELEASE_IMPACT_LABELS: Record<string, string> = {
  unlocks: '新機能',
  security: 'セキュリティ',
  improves: '改善',
  chore: 'その他',
};

function digestSummarySystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
今日のダイジェストの冒頭に置く、3〜5行の短い「今日の傾向」を書いてください。
これは個々の記事の紹介ではありません。**複数の項目を束ねて初めて見える、
その日の技術界隈の動きを俯瞰したインサイト**を渡してください。

# 読者プロフィール
${topics.profile}

# 材料
渡す情報は、このダイジェスト用に選定・要約済みの項目一覧と、分野・カテゴリ・
リリース内訳の集計です。新しい情報を付け足さず、この中から読み取れる傾向だけを書いてください。

# 見つけてほしいもの（該当するものだけでよい。無理に全部を満たそうとしない）
- ある分野・カテゴリに項目が偏っている
  例:「セキュリティ関連の修正が5件重なった」「AIエージェント関連の発表が続いた」
- 複数の項目が同じ方向を向いている
  例: 主要ツールが揃って同じ種類の機能を追加した、同じ問題への対処が複数ソースで見られた
- 際立って重要・意外な1件があり、それがその日の中心と言える
- 上記のどれにも当てはまらない日は、無理に大きな主語を作らず、
  「目立った偏りは無く、粒ぞろいの一日だった」のように率直に書いてよい

# 書き方
- 全体で3〜5行。1行1文、40字前後の平易な日本語。番号・記号・箇条書き記号は付けない。
- **個々の記事要約の言い換えではなく、複数項目を束ねた「傾向」を主語にする。**
  「〜という記事が公開された」ではなく「〜系の動きが目立った」の形にする。
  ただし際立って重要な1件は個別に触れてよい（傾向というほどの数が無い日はそれで足りる）。
- 渡された集計の数字は使ってよいが、実際の値だけを使い、作り話をしない。
  集計に現れない傾向を推測で足さない。
- 「本日のダイジェストをお届けします」のような自己言及・宣伝口調・煽り文句は禁止。
- 読者を主語にしない（「〜な方におすすめ」のような呼びかけをしない）。事実を淡々と置く。`;
}

function summarizeCounts(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

function formatCounts(counts: Record<string, number>, labels?: Record<string, string>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${labels?.[k] ?? k} ${v}件`)
    .join(' / ');
}

interface DigestSignals {
  articleCount: number;
  laneCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  buzzCount: number;
  releaseImpactCounts: Record<string, number>;
}

/** 記事・リリースを横断した集計。個々の要約からは見えない偏りを、数字として先に渡す */
function buildDigestSignals(top: TopItem[], releases: ReleaseItem[], others: RankedItem[]): DigestSignals {
  const articles = [...top, ...others];
  return {
    articleCount: articles.length,
    laneCounts: summarizeCounts(articles.map((i) => LANE_LABELS[i.lane] ?? i.lane)),
    categoryCounts: summarizeCounts(articles.map((i) => i.category)),
    buzzCount: articles.filter((i) => i.buzz).length,
    releaseImpactCounts: summarizeCounts(releases.map((r) => r.impact ?? 'chore')),
  };
}

function renderDigestSummaryContext(top: TopItem[], releases: ReleaseItem[], others: RankedItem[]): string {
  const signals = buildDigestSignals(top, releases, others);
  const statsLines = [
    `記事 ${signals.articleCount} 件の目的別内訳: ${formatCounts(signals.laneCounts) || 'なし'}`,
    Object.keys(signals.categoryCounts).length > 0
      ? `カテゴリ内訳: ${formatCounts(signals.categoryCounts)}`
      : null,
    signals.buzzCount > 0 ? `他のエンジニアとも話題になりやすい記事（◆話題） ${signals.buzzCount} 件` : null,
    releases.length > 0
      ? `リリース ${releases.length} 件の内訳: ${formatCounts(signals.releaseImpactCounts, RELEASE_IMPACT_LABELS)}`
      : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const topLines = top.map(
    (t) =>
      `- [ベスト/${LANE_LABELS[t.lane]}/${t.category}] ${t.title}\n  ${t.deep.summary}`,
  );
  const releaseLines = releases
    .slice(0, 20)
    .map(
      (r) =>
        `- [リリース/${RELEASE_IMPACT_LABELS[r.impact ?? 'chore']}] ${r.product}${r.version ? ` ${r.version}` : ''}: ${r.unlock ?? r.summary}`,
    );
  const otherLines = others
    .slice(0, 15)
    .map((o) => `- [その他/${LANE_LABELS[o.lane]}/${o.category}] ${o.oneLiner}`);

  return [
    `# 集計\n${statsLines}`,
    `# 項目一覧\n${[...topLines, ...releaseLines, ...otherLines].join('\n')}`,
  ].join('\n\n');
}

/**
 * LLM を使わないときのフォールバック。
 * 傾向の言語化までは無理せず、集計から機械的に言えることだけ並べる。
 */
function fallbackDigestSummary(top: TopItem[], releases: ReleaseItem[], others: RankedItem[]): string[] {
  const signals = buildDigestSignals(top, releases, others);
  const lines: string[] = [];

  const topCategory = Object.entries(signals.categoryCounts).sort((a, b) => b[1] - a[1])[0];
  if (topCategory && topCategory[1] >= 2) {
    lines.push(`「${topCategory[0]}」関連の記事が ${topCategory[1]} 件と今日は多めだった。`);
  }

  const securityCount = signals.releaseImpactCounts.security ?? 0;
  if (securityCount > 0) {
    lines.push(`リリース情報のうちセキュリティ関連の対応が ${securityCount} 件あった。`);
  }

  const firstTop = top[0];
  if (firstTop) {
    lines.push(`いちばんの注目は「${firstTop.oneLiner}」。`);
  }

  if (lines.length === 0 && (top.length > 0 || releases.length > 0 || others.length > 0)) {
    lines.push('目立った偏りは無く、粒ぞろいの一日だった。');
  }

  return lines.slice(0, 5);
}

export async function summarizeDigest(
  top: TopItem[],
  releases: ReleaseItem[],
  others: RankedItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<string[]> {
  if (top.length === 0 && releases.length === 0 && others.length === 0) return [];

  const b = await getBackend();
  if (!b) return fallbackDigestSummary(top, releases, others);

  try {
    const parsed = await complete(b, {
      stage: 'digest-summary',
      model: cfg.rankModel,
      maxTokens: 1000,
      system: digestSummarySystemPrompt(topics),
      prompt: `以下は今日のダイジェストの集計と項目一覧です。これをもとに、今日の技術界隈の傾向を3〜5行で書いてください。\n\n${renderDigestSummaryContext(top, releases, others)}`,
      schema: DigestSummarySchema,
    });
    const lines = (parsed.lines ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    return lines.length > 0 ? lines : fallbackDigestSummary(top, releases, others);
  } catch (err) {
    log.warn(`冒頭サマリー生成失敗: ${err instanceof Error ? err.message : err}`);
    return fallbackDigestSummary(top, releases, others);
  }
}

/* ------------------------------------------------------------------ *
 * 4) この先の見立て（サマリー末尾の一行）
 *
 * サマリー本体は「今日の材料から読み取れることだけ」に閉じている。
 * それだけだと日々の点は分かっても流れが分からないので、
 * 直近数日のサマリーを並べて、現状の位置づけとこの先の方向を一行で書かせる。
 * ここだけは推測を許す代わりに、推測と分かる語尾を強制する。
 * LLM が無い日は書かない——集計から機械的に作れる類のものではない。
 * ------------------------------------------------------------------ */

export interface DigestHistory {
  date: string;
  summary: string[];
}

function digestOutlookSystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
今日のダイジェストの冒頭サマリーの最後に置く「この先の見立て」を1行で書いてください。
読者が時流を読む助けになることが目的です。

# 読者プロフィール
${topics.profile}

# 材料
今日の項目一覧と集計に加えて、直近数日分のサマリーを日付順に渡します。
1日の出来事ではなく、**数日並べて初めて見える流れ**として読んでください。

# 1行に必ず両方を入れる
- 現状: いまエンジニアリング業界がどの局面にいるか。何が定着しつつあり、何がまだ揺れているか。
- この先: その流れの向かう先。次に焦点になりそうな論点や、仕事の仕方の変化。

# 書き方
- 1〜2文、合計90〜130字程度の平易な日本語。番号・記号・箇条書き記号は付けない。
- 推測であることが分かる語尾（〜しつつある、〜になりそう、〜が焦点になる）を使い、断定しない。
- 材料に無い製品名・数字・出来事を持ち込まない。推測は材料から辿れる範囲にとどめる。
- 今日の出来事の言い換えで終わらせない。必ず「いまどこにいて、この先どちらへ動きそうか」を書く。
- 数日分を通した変化（増えた・減った・焦点が移った）が読み取れるなら、それを優先する。
- 煽り文句・自己言及・読者への呼びかけをしない。事実と見立てを淡々と置く。`;
}

export async function forecastOutlook(
  todaySummary: string[],
  history: DigestHistory[],
  top: TopItem[],
  releases: ReleaseItem[],
  others: RankedItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<string | null> {
  if (top.length === 0 && releases.length === 0 && others.length === 0) return null;

  const b = await getBackend();
  if (!b) return null;

  // 古い日付が上に来るように並べ替える（流れは時系列で読ませたい）
  const historyBlock = [...history]
    .sort((a, b2) => a.date.localeCompare(b2.date))
    .map((h) => `## ${h.date}\n${h.summary.map((l) => `- ${l}`).join('\n')}`)
    .join('\n\n');

  const context = [
    historyBlock ? `# 直近数日のサマリー\n${historyBlock}` : null,
    todaySummary.length > 0 ? `# 今日のサマリー\n${todaySummary.map((l) => `- ${l}`).join('\n')}` : null,
    `# 今日の詳細\n${renderDigestSummaryContext(top, releases, others)}`,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n\n');

  try {
    const parsed = await complete(b, {
      stage: 'digest-outlook',
      model: cfg.summaryModel,
      maxTokens: 1000,
      effort: cfg.summaryEffort,
      system: digestOutlookSystemPrompt(topics),
      prompt: `以下が材料です。これをもとに「この先の見立て」を1行で書いてください。\n\n${context}`,
      schema: DigestOutlookSchema,
    });
    return parsed.outlook?.trim() || null;
  } catch (err) {
    log.warn(`この先の見立ての生成失敗: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
