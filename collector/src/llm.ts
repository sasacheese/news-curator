import type { LlmBackend } from './backend.js';
import { selectBackend } from './backend.js';
import { CATEGORIES } from './categories.js';
import type { RuntimeConfig } from './config.js';
import {
  DeepDiveSchema,
  DescribeResultSchema,
  DigestSummarySchema,
  ScoreResultSchema,
  type DescribeResult,
} from './schemas.js';
import { DURABILITIES, PAYOFFS } from './types.js';
import type {
  DeepDive,
  PreScoredItem,
  RankedItem,
  ReleaseItem,
  TopicsConfig,
  TopItem,
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

function scoreSystemPrompt(topics: TopicsConfig, feedbackNote?: string | null): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡された記事を、この読者にとっての「今日読む価値」で 0〜100 点に採点してください。

${readerContext(topics, feedbackNote)}

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

function describeSystemPrompt(topics: TopicsConfig, feedbackNote?: string | null): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
選抜済みの記事について、一覧に載せる要約とキーワードを書いてください。

${readerContext(topics, feedbackNote)}

# 出力
- すべて日本語で書く。
- oneLiner は「何が起きたか」を主語述語のある1文で。「〜について」のような曖昧な書き方は禁止。
- reason は「どの観点で読むとよいか」。詳しくは下の節を参照。
- keywords は後から検索するためのもの。製品名・API名・バージョン番号などの固有名詞を優先する。
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# reason（読みどころ）
記事が明らかにした事実を、**その分野を知らない人にも通じる言葉で**書く。

## いちばん大事なこと: 読者を主語にしない
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

## 言葉づかい
- **平易に書く。** 読者は有能なエンジニアだが、その記事の分野は専門外かもしれない。
  知らない固有名詞が並ぶと、読みどころがただのノイズになる。
- **固有名詞・関数名・環境変数名は、何をするものか 1〜3 語で添えられるときだけ出す。**
  添えられないなら普通の言葉に言い換える。名前そのものは記事を開けば分かる。
- **数字は残す。** 前提知識が要らないので、専門外にも効く唯一の具体。
  「大幅に速い」ではなく「1.2 秒 → 40ms」、「先月廃止」ではなく「7月31日に廃止済み」。
- 「A だと思われがちだが実は B」「原因は X ではなく Y だった」の形にできるなら、それが一番強い。
- 煽らない。「驚きの」「必見」は禁止。答えを伏せるのも禁止。
- **2 文以内・100 字以内。** 詰め込むより削る。

## 発見が無い記事のとき
入門記事や淡々とした告知には意外性が無い。**無理に作らない。**
何が書いてあるかを 1 文で率直に書く。
記事に書かれていないことを推測で足すのは、この項目で一番やってはいけないこと。

## もう 2 例
✗「.map ファイルからコメント付きの全 TypeScript / React コードが復元でき、GraphQL / REST の Read-Only トークンで下書き・非公開コンテンツ全件取得が可能で、Mangle 程度の難読化は数秒で解読される、という実装レベルの脆弱性。」
　記事の語彙をそのまま持ってきた抜粋。長すぎて一息で読めない。
✓「ビルド時に出力されるソースマップから、元のコードがコメントごと復元できてしまう。公開設定を見落とすと、下書き記事も外から読める。」

✗「この構成を使っているなら、source map の公開設定と Token 権限を今日中に確認すべき。」
　読者への指示になっている。何が起きるのかを書く。
✓「読み取り専用のはずのトークンで、下書きや非公開の記事まで全部取れてしまう。権限を絞ったつもりでも防げていない。」

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# reason（読みどころ）
**その分野を知らない人にも意味が取れる言葉で、「何ができるようになるか」か
「これまでと何が違うか」を書く。** 記事からの抜粋ではなく、噛み砕いた言い直し。

## 守ること
- **平易な日本語で書く。** 読者は有能なエンジニアだが、その記事の分野は専門外かもしれない。
  知らない固有名詞が並ぶと、読みどころがただのノイズになる。
- **固有名詞・関数名・環境変数名は、「それが何か」を 1〜3 語で添えられるときだけ出す。**
  添えられないなら、普通の言葉に言い換える。名前そのものは記事を開けば分かる。
- **数字は残す。** 数字は前提知識が要らないので、いちばん伝わる具体。
  「大幅に速い」ではなく「1.2 秒 → 40ms」、「先月廃止」ではなく「7月31日に廃止済み」。
- 次のどちらかの形になっていること（両方でもよい）。
  - **何ができるようになるか** — これまで手作業だったこと・諦めていたことが可能になる
  - **これまでと何が違うか** — 従来のやり方・古いバージョン・世間の通説との差
- 「A だと思われがちだが実は B」「原因は X ではなく Y だった」の形にできるなら、それが一番強い。
- 「参考になる」「判断材料になる」「確認できる」「押さえておきたい」で締めない。
  読者に判断を丸投げする逃げで、何も言っていない。
- 煽らない。「驚きの」「必見」の類は禁止。答えを伏せるのも禁止。
- 60〜100字。1〜2文。条件節（「〜するなら」「〜する際に」）から始めない。

## 発見が無い記事のとき
入門記事・淡々とした告知など、意外性が無いものもある。**無理に作らない。**
何が書いてあるかを 1 文で率直に書く。
記事に書かれていないことを推測で足すのは、この項目で一番やってはいけないこと。

## 例
✗「既存の開発環境でログやリクエストトレースが自動収集される点と、マルチプロセス構成で XLOCALOBSERVABILITY を無効化する条件を確認したい。」
　その製品を使っていない人には一語も意味が取れない。環境変数名を出すなら何をするものか添える。
✓「ローカル開発でもリクエストの記録が自動で残るようになった。複数プロセスで動かしているときだけ、記録を切る設定がいる。」

✗「Gemini固有の予約関数やフォーム操作の失敗条件に注目すると、Playwright系のブラウザエージェントを安全に組み込む際の切り分けに使える。」
　「予約関数」「失敗条件」が抽象的で、何が起きるのか分からない。
✓「AI にブラウザを操作させると、フォーム入力で黙って失敗することがある。どの操作が危ないかを実際に試して切り分けている。」

✗「MCPをClaude Codeへ増設する前に、ツール数よりモデル差とキャッシュ設計がコストを左右する条件を確認できる。」
　「確認できる」で締めて、結論がどちらなのか言っていない。
✓「ツールを増やすと高くつくと思われがちだが、実測で効いていたのは設定の方だった。26 個積んでも 1 回 $0.03 に収まっている。」

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# reason（読みどころ）
その記事で**一番おもしろい発見を、答えごと書く**。読者への推薦文ではない。
「読むと得られるもの」を紹介するのではなく、記事が明らかにした事実そのものを短く置く。

## 守ること
- **意外な事実・直感に反する結論を名指しする。** 「〜が意外だった」「〜に注目」と
  指差して終わらない。何が意外なのかを書き切る。答えを伏せない。
- **誤解が解ける構造があればそれを書く。** 「A だと思われがちだが実は B」「原因は
  X ではなく Y だった」は一番強い。記事がその形をしているなら迷わずそう書く。
- **数字・固有名詞・関数名はそのまま出す。** 「大幅に改善」ではなく「p95 が 1.2 秒から 40ms」。
  「7月末に廃止」ではなく「7月31日に廃止済み」。具体が知的な引っかかりを作る。
- **推薦しない。** 「参考になる」「判断材料になる」「価値がある」「押さえておきたい」
  「〜できる」は読者に判断を丸投げする逃げ。事実を置けば、読むかどうかは読者が決める。
- **煽らない。** 「驚きの」「必見」「衝撃」の類は禁止。中身のない気の持たせ方をしない。
- 60〜100字。1〜2文。条件節（「〜するなら」「〜する際に」）から始めない。

## 発見が無い記事のとき
入門記事・リリース告知・淡々とした手順書など、意外性が無いものもある。
**無理に作らない。** その場合は何が書いてあるかを 1 文で率直に書く。
記事に書かれていないことを推測で足すのは、この項目で一番やってはいけないこと。

## 例
✗「MCPをClaude Codeへ増設する前に、ツール数よりモデル差とキャッシュ設計がコストを左右する条件を確認できる。」
　「確認できる」で締めて、結論がどちらなのか言っていない。
✓「ツールを 26 個積んだときの追加コストは 1 回 $0.03。ただし効いているのはツール数ではなくキャッシュ設定で、同じ構成でもモデルを変えると差が開く。」

✗「Claude Codeや共有機能を業務で使うなら、robots.txtとnoindexの非対称性に注目したい。」
　「注目したい」が逃げ。非対称性が何なのかを言う。
✓「robots.txt はクロールを止めるがインデックスは止めない。共有リンクが検索に載った事故はこの非対称性が原因で、noindex ヘッダーでなければ防げなかった。」

✗「この記事の実装ログは事例になる。特にセキュリティの指摘順序が意外だったという指摘は参考になる。」
　「意外だった」と言うだけで何が意外なのか書いていない。これが一番もったいない書き方。
✓「認証の実装より先に、ログに載る個人情報の方を指摘してきたという順序が記録されている。危険度の見積もりが人間と違う例。」

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# reason（読みどころ）
読む前の人に「どこを見ればいいか」を一言で渡す。要約の言い換えでも、記事の目次でもない。

## 守ること
- **記事の中の具体を 1 つだけ引く。** 数字・関数名・製品名・その記事の主張のうち、
  一番効くものを 1 つ選ぶ。中黒で複数を並べない。
- **読んだあとに何が分かるのかを書き切る。** 「確認できる」「判断できる」「把握できる」
  「役立つ」「参考になる」「重要」で締めない。それらは何も言っていない。
- **条件節から始めない。** 「〜するなら」「〜する際に」「〜する前に」で書き出すと
  全部が同じ形になる。言い切りから入る。
- 60〜100字。1〜2文。記事に書かれていない効能を推測で足さない。

## 例
✗「Node.jsでTypeScriptを直接実行する構成やViteを使う構成を選ぶ際に、出力形式・解決規則・型チェックを分離して判断できる。」
　条件節が長く、名詞を並べて「判断できる」で終わっている。結局何が分かるのか書いていない。
✓「enum と namespace が『使わない方がよい機能』に格下げされた経緯が本題。手元の tsconfig にこの 2 つが残っているなら、外す判断の根拠になる。」

✗「MCPをClaude Codeや自作エージェントへ増設する前に、ツール数よりモデル差とキャッシュ設計がコストを左右する条件を確認できる。」
　「確認できる」で締めていて、結論がどちらなのか分からない。
✓「ツールを 26 個積んでも高くつくのはツール数のせいではなく、モデル選択とキャッシュ設定のせいだった、という実測が結論。増設をためらっているなら読む価値がある。」

✗「Claude Codeや共有機能を業務で使うなら、robots.txtとnoindexの非対称性が機密情報の公開経路になった点に注目したい。」
　「注目したい」が逃げになっている。何が起きたのかを言う。
✓「共有リンクが robots.txt では止まらず検索に載った、という事故の経緯そのものが読みどころ。同じ勘違いを自分の公開設定でもしていないか確かめられる。」

# category（分類）
次の中から最も近いものを1つ選ぶ。
${CATEGORIES.join(' / ')}
「その他」はどれにも当てはまらないときだけ。迷ったら主題に一番近いものを選ぶ。
（スキーマの制約は生成時に効いていないので、ここの指示で選ぶこと）

# reason（読みどころ）
**要約の言い換えを書かない。** oneLiner が「何が書いてあるか」なら、
reason は「それをどう読むと自分の役に立つか」を書く。
読者がその記事を開く前に、どこに注目すればよいかがわかる一文にする。

書き方のパターン:
- 記事の主題より価値のある副次的な部分を指す
  例:「移行手順そのものより、なぜその設計を選んだかの判断基準が自分の環境にも効く」
- 読者の既存の関心・作業に接続する
  例:「同じ構成を Next.js でも組んでいるなら、ここでの落とし穴はそのまま当てはまる」
- 使いどころと使いどころでないところを分ける
  例:「小規模では過剰だが、CI が遅くなってきたチームには導入判断の材料になる」
- 数字や主張の読み方を示す
  例:「30%短縮という数字より、どの条件で測ったかを見ると自分のケースに換算できる」

- 60〜90字。「〜に役立つ」「重要な知識」のような中身のない締めで終わらせない。
- 一般論ではなく、この読者のプロフィールに紐づける。
- 記事に書かれていない効能を推測で足さない。

# domain（AI か否か）
- LLM・生成AI・AIエージェント・コーディングエージェントそのものが主題なら ai。
- AI を道具として使った話（AI で何かを作ってみた等）でも、記事の主題が AI の使い方なら ai。
- 主題が Web フロントエンド・インフラ・言語仕様などで、AI は文中に出てくるだけなら general。

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
/** 要約前に AI 関連かを粗く見分ける。候補の広げ方を決めるためだけに使う */
function looksAi(item: PreScoredItem): boolean {
  return item.matchedTopics.some((t) => /AI|Claude|Codex/.test(t));
}

/** 一次情報か。ベスト3の枠確保の対象になりうるかの判定に使う */
function isPrimarySource(item: PreScoredItem): boolean {
  return item.source === 'rss' || item.source === 'github_release' || item.source === 'changelog';
}

function ruleBasedFields(item: PreScoredItem, note: string) {
  return {
    oneLiner: truncate(item.snippet.replace(/\s+/g, ' ').trim(), 80) || item.title,
    reason: note,
    keywords: item.matchedTopics.slice(0, 5),
    category: 'その他',
    domain: looksAi(item) ? ('ai' as const) : ('general' as const),
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
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<Map<string, number>> {
  const batches: PreScoredItem[][] = [];
  for (let i = 0; i < items.length; i += cfg.rankBatchSize) {
    batches.push(items.slice(i, i + cfg.rankBatchSize));
  }

  const system = scoreSystemPrompt(topics, feedbackNote);
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

/**
 * 要約 1 リクエストあたりの件数。
 * 出力が大きい段なので、採点（18件）より小さく刻む。
 */
const DESCRIBE_BATCH_SIZE = 12;

/** 2 段目: 実際に保存する分だけ文章化する */
async function describePass(
  b: LlmBackend,
  shortlist: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
): Promise<Map<string, DescribeResult['items'][number]>> {
  const described = new Map<string, DescribeResult['items'][number]>();
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

  const system = describeSystemPrompt(topics, feedbackNote);
  await mapLimit(batches, 3, async (batch, batchIndex) => {
    // ref は採点段と同じく通し番号で振る（実装が食い違うと取り違えの温床になる）
    const offset = batchIndex * DESCRIBE_BATCH_SIZE;
    const body = batch.map((item, i) => renderCandidate(item, offset + i, 700)).join('\n\n');
    try {
      const parsed = await complete(b, {
        stage: 'describe',
        model: cfg.rankModel,
        maxTokens: 16000,
        system,
        prompt: `以下 ${batch.length} 件を要約してください。\n\n${body}`,
        schema: DescribeResultSchema,
      });
      for (const r of parsed.items ?? []) {
        const item = shortlist[r.ref];
        if (item) described.set(item.id, r);
      }
    } catch (err) {
      log.warn(`要約 batch ${batchIndex}: ${err instanceof Error ? err.message : err}`);
    }
  });

  return described;
}

export async function rankItems(
  items: PreScoredItem[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  feedbackNote?: string | null,
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
  const scores = await scorePass(b, items, topics, cfg, feedbackNote);
  log.info(`  スコアリング: ${scores.size}/${items.length} 件`);

  const scoreOf = (item: PreScoredItem) =>
    // 採点に失敗した分は事前スコアで代替する（控えめに）
    scores.get(item.id) ?? Math.round(item.preScore * 60);

  /**
   * 2 段目に回す候補。
   *
   * 単純なスコア上位だけでは足りない。一覧は AI 以外に別枠を与えており、
   * ベスト3も一次情報の枠を確保するため、どちらもスコア順の外から拾うことがある。
   * 要約されていない項目が選ばれると、要約が本文の切り出しになり、
   * durability も既定値になる（判定していないのに枠を満たしてしまう）。
   * その分だけ候補を広げておく。
   */
  const byScore = [...items].sort((a, b2) => scoreOf(b2) - scoreOf(a));
  // topN は AI / AI以外 の 2 グループぶん必要
  const base = byScore.slice(0, cfg.topN * 2 + cfg.otherN + 10);
  const baseIds = new Set(base.map((i) => i.id));
  // ベスト N もドメイン別・一次情報枠でスコア順の外から拾うので、その分も見込む
  const headroom = cfg.topN + Math.ceil(cfg.otherN / 2);
  const extra = [
    ...byScore.filter((i) => !baseIds.has(i.id) && !looksAi(i)).slice(0, headroom),
    ...byScore.filter((i) => !baseIds.has(i.id) && isPrimarySource(i)).slice(0, headroom),
  ];
  const shortlist = [...base, ...new Map(extra.map((i) => [i.id, i])).values()];

  const described = await describePass(b, shortlist, topics, cfg, feedbackNote);
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
      domain: r.domain === 'ai' ? 'ai' : 'general',
      readingMinutes: Number.isFinite(r.readingMinutes)
        ? Math.max(1, Math.min(30, Math.round(r.readingMinutes)))
        : 5,
      payoff: PAYOFFS.includes(r.payoff) ? r.payoff : 'aware',
      durability: DURABILITIES.includes(r.durability) ? r.durability : 'durable',
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

/* ------------------------------------------------------------------ *
 * 3) 冒頭サマリー
 *
 * ベスト N・リリース情報・その他の注目記事が出揃った後、それらを material に
 * その日のダイジェスト全体を紹介する短い案内文を作る。すでに要約済みの
 * headline/oneLiner/summary から合成するだけなので、安い rankModel で足りる。
 * ------------------------------------------------------------------ */

function digestSummarySystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
今日のダイジェストの冒頭に置く、3〜5行の短い案内文を書いてください。
読者はこれから本文を読みます。この案内文はその日何が載っているかの見取り図です。

# 読者プロフィール
${topics.profile}

# 材料
これから渡す一覧は、すでにこのダイジェスト用に選定・要約済みの項目です。
新しい情報を付け足さず、この中から今日際立っているものを選んで案内文にしてください。

# 書き方
- 全体で3〜5行。1行1文、40字前後の平易な日本語。番号・記号・箇条書き記号は付けない。
- その日実際に載っている具体的な項目（記事名やリリース名そのものではなく、
  そこで何が起きたか）を書く。カテゴリを網羅しようとしない。
  ベスト記事が2件しかなければ2件だけ、リリースが無ければリリースには触れない。
- 「本日のダイジェストをお届けします」のような自己言及・宣伝口調・煽り文句は禁止。
- 数字・固有名詞は具体的に残す（「大幅刷新」ではなく中身を書く）。
- 読者を主語にしない（「〜な方におすすめ」のような呼びかけをしない）。事実を淡々と置く。`;
}

function renderDigestSummaryContext(top: TopItem[], releases: ReleaseItem[], others: RankedItem[]): string {
  const topLines = top.map(
    (t) => `- [ベスト/${t.domain === 'ai' ? 'AI' : 'AI以外'}] ${t.deep.headline}\n  ${t.deep.summary}`,
  );
  const releaseLines = releases
    .slice(0, 20)
    .map((r) => `- [リリース] ${r.product}${r.version ? ` ${r.version}` : ''}: ${r.unlock ?? r.summary}`);
  const otherLines = others.slice(0, 15).map((o) => `- [その他] ${o.oneLiner}`);

  return [...topLines, ...releaseLines, ...otherLines].join('\n');
}

/** LLM を使わないときのフォールバック。件数だけの素っ気ない案内になる */
function fallbackDigestSummary(top: TopItem[], releases: ReleaseItem[], others: RankedItem[]): string[] {
  const lines: string[] = [];
  if (top.length > 0) {
    lines.push(`ベスト${top.length}件: ${top.map((t) => t.deep.headline).join(' / ')}`);
  }
  if (releases.length > 0) {
    lines.push(
      `リリース情報 ${releases.length} 件（${releases
        .slice(0, 3)
        .map((r) => r.product)
        .join('、')} ほか）を掲載。`,
    );
  }
  if (others.length > 0) {
    lines.push(`その他の注目記事を ${others.length} 件掲載。`);
  }
  return lines;
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
      prompt: `以下は今日のダイジェストに載る項目です。これをもとに3〜5行の案内文を書いてください。\n\n${renderDigestSummaryContext(top, releases, others)}`,
      schema: DigestSummarySchema,
    });
    const lines = (parsed.lines ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    return lines.length > 0 ? lines : fallbackDigestSummary(top, releases, others);
  } catch (err) {
    log.warn(`冒頭サマリー生成失敗: ${err instanceof Error ? err.message : err}`);
    return fallbackDigestSummary(top, releases, others);
  }
}
