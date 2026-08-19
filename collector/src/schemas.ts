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
const describeItemShape = {
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
  takeaways: z
    .array(z.string())
    .describe(
      'この記事が何を言っているのかを、誰が読んでも分かる言葉で書いた3行。**ちょうど3項目。1項目は1文だけで、句点で終わらせる**（2文に分けたくなったら削るか、もう1項目に回す）。' +
        '**1項目に読点（、）を使わない。40字以内。** 読点を挟みたくなったら、それは1文に2つのことを詰めている合図なので、片方を捨てる。' +
        '✓「AIが書いたコードは動いてもセキュリティは別問題だった。」（読点なし・28字）' +
        '✗「AIが書いたコードは見た目は正しく動いても、実は遅かったり危なかったり、保守しにくいことがある。」（読点2つ・49字。3つのことを詰めている）' +
        '専門用語・略語・API名・オプション名・設定名は使わない（製品名は主題の特定に必要な1〜2個まで、それ以外は普通の言葉に言い換える）。' +
        '読者を主語にしない（「〜するなら」で始めない、「参考になる」「材料になる」で終わらない）。数字は残す。',
    ),
  keywords: z.array(z.string()).describe('検索用キーワード3〜6個（固有名詞優先）'),
  readingMinutes: z.number().int().describe('元記事を読み通すのにかかる分数の目安。1〜30。'),
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
};

export const DescribeResultSchema = z.object({
  items: z.array(z.object(describeItemShape)),
});

/**
 * talk レーン専用。要約に加えて「意見の足場」を書かせる。
 *
 * このレーンだけスキーマを分けているのは、know / build の要約にまで
 * 5 項目ぶんの出力を足すとコストが乗るのと、争点の無い記事に無理やり
 * 争点を書かせることになるため。レーンごとにバッチが分かれているので
 * スキーマも分けられる。
 */
export const TalkDescribeResultSchema = z.object({
  items: z.array(
    z.object({
      ...describeItemShape,
      debateAxis: z
        .string()
        .nullable()
        .describe(
          '争点を「A か B か」の形で1行。例:「レビューを自動化すべきか、人が最終確認すべきか」。同じ事実から違う結論が出る対立軸を書く。事実が争われているだけ（正しいか誤りか）なら争点ではないので null。',
        ),
      debateFor: z
        .string()
        .nullable()
        .describe(
          '記事の立場（賛成側）の一番強い言い分を1文・60字以内。記事が挙げている具体・数字を1つ含める。争点が無ければ null。',
        ),
      debateAgainst: z
        .string()
        .nullable()
        .describe(
          '反対側の一番強い言い分を1文・60字以内。藁人形にしない——実際にその立場を取る人が言いそうなことを書く。争点が無ければ null。',
        ),
      debateOneSided: z
        .boolean()
        .catch(false)
        .describe(
          '記事が片側の立場しか書いていないなら true。true のとき debateAgainst は記事の外から補った一般的な反論であり、記事の引用として使ってはいけないことを示す。',
        ),
      debateYourAngle: z
        .string()
        .nullable()
        .describe(
          '読者プロフィールに照らして、読者が実体験として語れそうな接点を1文・60字以内。意見の下書きではなく、「どこが読者にとって一次情報になるか」を指す。例:「同じ構成を業務で毎日動かしているので、〜の頻度は実測値として出せる」。接点が無ければ null。',
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

/**
 * 構成図。「何がどこを経由してどこへ届くか」を層で表す。
 *
 * 任意のグラフ（自由な位置のノード＋任意の矢印）にはしていない。座標を生成させると
 * 線が交差して読めなくなるうえ、レイアウトの当たり外れが出力ごとに変わる。
 * **上から下へ積む層**に限れば、生成側は座標を持たずに済み、描画は必ず一意に決まる。
 * 記事に出てくる構成のほとんどは「呼ぶ側 → 経由するもの → 実体」の層で表せる。
 */
const ArchitectureSchema = z.object({
  type: z.literal('architecture'),
  title: z.string().describe('何の構成か。20字以内。'),
  layers: z
    .array(
      z.object({
        label: z.string().describe('その層が何なのか（「呼ぶ側」「接続先」「実体」など）。12字以内。'),
        nodes: z
          .array(
            z.object({
              name: z.string().describe('要素の名前。記事の表記のまま。16字以内。'),
              note: z
                .string()
                .nullable()
                .describe('それが何をするものか。20字以内。名前だけで分かるなら null。'),
              highlight: z
                .boolean()
                .catch(false)
                .describe(
                  '**記事が論じている当のもの**なら true。「この記事は構成のどこの話か」を示すために使う。各層に高々1つ、図全体で1〜2個まで。',
                ),
            }),
          )
          .describe(
            'その層にあるもの。1〜4個。**並び順に意味を持たせる**——画面では層をまたいで同じ位置が縦に揃うので、n 番目は上の層の n 番目から繋がるものを置く。経路が 2 本ある構成（人が通る道とエージェントが通る道など）は、左の列と右の列でそれぞれ 1 本の経路になるように並べる。経路が 1 本しかない層は 1 個だけにする（余りを埋めない）。',
          ),
        via: z
          .string()
          .nullable()
          .describe(
            '**次の層へ何が渡るか**（「OpenAI 互換 API」「HTTP リクエスト」「盗んだ認証情報」など）。12字以内。最後の層は null。分からなければ null。',
          ),
      }),
    )
    .describe('上から下へ積む層。2〜4層。呼ぶ側を上、実体を下にする。'),
});

/** 3 レーンで共通の骨格。ここに各レーン固有の項目を足す */
const deepDiveBaseShape = {
  summary: z
    .string()
    .describe(
      '記事の内容の要約。4〜6文。takeaways（専門用語を使わない3行）とは役割が違い、こちらは**記事の語彙をそのまま使って詳しく**書く。製品名・API名・オプション名・バージョン・数値を省略も言い換えもしない——読者は分からない語をその場で開いて説明を読めるので、易しくする必要はない。「何が起きたか」だけで止めず、どういう仕組みでそうなるのか・結果として何が起きるのかまで踏み込む。',
    ),
  prerequisites: z
    .array(PrerequisiteSchema)
    .describe(
      '読者が詰まりそうな箇所を先回りして埋める解説。4〜8個で網羅側に倒す（迷ったら入れる）。term は自分が summary や箇条書きで実際に使った語とそろえる。本当に詰まる箇所が無ければ空配列。',
    ),
  visual: z
    .union([ComparisonSchema, FlowSchema, MetricsSchema, ArchitectureSchema])
    .nullable()
    .describe(
      '記事のいちばん重要な構造を1つだけ図にする。**箇条書きに書いたことを表に組み替えただけの図は作らない（それなら null）。** 何がどこを経由してどこへ届くかは architecture、時間の前後・順序があるものは flow、二つの状態の対比は comparison、記事に実測値があるものは metrics。どれにも当てはまらない、または文章で足りているなら null。',
    ),
  figures: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .describe('引用する画像の番号。渡された候補（[画像N]）にある番号だけを使い、無い番号を書かない。'),
        caption: z
          .string()
          .describe(
            'その画像が何を示しているかを、解説の文脈で書く。40〜80字。**alt の写しにしない。**「〜の画像」「〜のスクリーンショット」で終わらせず、その画像から読み取れること（どの数値がどう動いたか、どの画面のどこが変わったか）を書く。記事に書かれていないことを画像から推測して書かない。',
          ),
      }),
    )
    .describe(
      '記事の中の画像のうち、解説で引用するもの。**0〜2 枚。既定は空配列。** 候補が渡されていなければ必ず空配列にする。',
    ),
  code: z
    .object({
      lang: z.string(),
      caption: z.string(),
      content: z.string(),
    })
    .nullable()
    .describe('そのまま使えるコード。不要なら null。'),
  relatedLinks: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .describe('記事本文中にあった一次情報へのリンク。無ければ空配列。'),
  readingMinutes: z.number().int().describe('このカードを読むのにかかる分数の目安'),
};

/** 知る: 使い方ではなく「自分がどう巻き込まれるか」を書く */
export const KnowDeepDiveSchema = z.object({
  ...deepDiveBaseShape,
  impact: z
    .array(z.string())
    .describe(
      '**この記事が関係する人を、「〜な人」の形で淡々と列挙する。2〜4個、各30字以内。** ✓「deepseek-v4-pro をAPIで使っている人」「厳密なJSON抽出をしている人」/ ✗「many-ai-cli に対応を追加・検討している開発者が対象。OpenRouter は独立したプロバイダではなく…」（説明が混ざっている）。**説明も理由も影響の内容も書かない**——ここは該当するかどうかを目で拾うためだけの一覧なので、「〜なので」「〜のため」「〜になる」が入ったら書きすぎ。影響の内容は summary の仕事。「広く影響する」のような曖昧な書き方は禁止。対象が特定できないなら「範囲不明」の1項目だけにする。',
    ),
  timeline: z
    .array(z.string())
    .describe(
      '日付が本体の情報だけ。**1項目1行・40字以内。0〜3個。**「2026-08-31 サポート終了」のように日付＋出来事だけを置く。報道や資金調達の経緯は書かない——読者の期限（いつから効くか・いつまでに動くか）を優先する。記事に時期の記述が無ければ空配列。',
    ),
  checkNow: z
    .array(z.string())
    .describe(
      '読者がいま取るアクション。**1項目1行・60字以内。2〜3個。** 該当するかを調べるコマンド、見るべき設定ファイル、暫定の回避策。打てるコマンド・開くファイル名まで具体化する。「注意する」「確認しておく」のような、何をするか決まらない書き方は禁止。',
    ),
  unknowns: z
    .array(z.string())
    .describe(
      'まだ確定していないこと。**1項目1行・40字以内。0〜3個。** 進行中の事象では、判明している事実と推測の境目を明示する。すべて確定している記事なら空配列。推測を確定として書かないこと。',
    ),
});

/** 作る: 読者はこのカードを読んでそのまま手を動かす */
export const BuildDeepDiveSchema = z.object({
  ...deepDiveBaseShape,
  unlocks: z
    .array(z.string())
    .describe(
      'できるようになること。**読んだ人が「そんなことができるのか、試したい」と思う一点を書く。1〜2個、各45字以内。** ' +
        '**目に浮かぶ具体で書くこと。** 読者が頭の中で動いている絵を思い描けなければ、その項目は失敗している。' +
        '✓「録画を投げると、話者ごとに分けた字幕がそのまま返ってくる」（絵が浮かぶ）' +
        '✗「音声処理をパイプライン経由の話者分離モジュールにも型付きで開放できる」（仕組みの説明で、何が嬉しいか浮かばない）' +
        '**仕組みの名前を主語にしない。** 読者が何をできるかを主語にする。' +
        '「速くなる」「便利になる」「効率化できる」は程度の改善であって、できるようになることではない。' +
        '付随的な機能を並べない——2個目を書くなら、1個目と種類が違うことだけ。' +
        '本当に新しくできることが無い記事なら、何が楽になるのかを1つだけ率直に書く（無理に盛らない）。',
    ),
  howToTry: z
    .array(z.string())
    .describe(
      '試す手順。インストールから最初の結果が出るまでを、読者が調べ直さずに済む粒度で書く。2〜5ステップ。「試してみましょう」は禁止。',
    ),
  fitFor: z
    .array(z.string())
    .describe(
      '使える場面。**読者が自分に当てはまるかを YES / NO で答えられる条件**を書く。1〜3個、各50字以内。人物像ではなく、観測できる状態で書くこと。✗「効率化したい開発者に向いている」（誰にでも当てはまり判定できない）/ ✓「CI のビルドが 5 分を超えているとき」/ ✓「TypeScript で書いた CLI を配布しているとき」。読者が自分の環境を見て即答できる形になっているかを、書いたあとに必ず確認する。',
    ),
  notFor: z
    .array(z.string())
    .describe(
      '向かない場面。**当てはまったら読まなくてよい条件**を書く。1〜3個、各50字以内。fitFor と同じく観測できる状態で書く。使えない（未対応）ものと、使えるが不適なものの両方を含めてよい。✗「本格的な用途には向かない」（判定できない）/ ✓「Windows で動かすとき（未対応）」/ ✓「月 1 万リクエスト未満なら手作業のままでよい」。新しい道具ほど適用範囲は狭いが、そこは書かれないことが多い。記事から読み取れる範囲で書き、推測で広げない。',
    ),
  caveats: z
    .array(z.string())
    .describe(
      '**最重要の1つだけ。0〜1個、50字以内。** 次のどれかに当たるもののうち、いちばん起こりやすく損害が大きい1つを選ぶ: (1) 知らずに始めると詰まる前提（別ツールの導入、対応していない環境）(2) 想定外にお金がかかる (3) データや既存の設定が壊れる。' +
        '**仕様の細部はここに書かない。** ✗「style: react は動作するが非推奨警告あり」✗「上限はモデル構造依存: GQAはKVヘッド数まで」（どちらも仕様の説明であって、知らずに始めて困ることではない）/ ✓「Node.js 22.13未満だとローカル起動の時点でつまずく」✓「通信はHTTPS経由だがエンドツーエンドでは暗号化されない」。' +
        '「まだ新しいので注意」「本番利用は慎重に」のような、どの新しい道具にも言える一般論も書かない。該当が無ければ空配列にする——**埋めるために書かない。**',
    ),
});

/**
 * 話す: 発信するための材料を渡す。意見の下書きは作らない。
 *
 * 以前は賛成側の根拠・反対側の根拠を**別々の平行なリスト**（各2〜4項目）で持っていた。
 * 読者が頭の中で対応づけないと噛み合いが見えず、実測では対応していない項目もあった
 * （記事と同じ立場の補強が「反対側の根拠」に混ざっていた）。議論の形は
 * 「A と言われるが B だ」という噛み合いなので、**論点ごとに対で持つ**形に変えた。
 */
export const TalkDeepDiveSchema = z.object({
  ...deepDiveBaseShape,
  clashes: z
    .array(
      z.object({
        point: z.string().describe('何について争っているか。名詞句で20字以内。例:「何を先に決めるか」'),
        claim: z
          .string()
          .describe(
            'その論点について**こう言われる**（記事の立場）。**50字以内を厳守。** 記事が挙げている具体・数字を含める。**記事の紹介文にせず、主張そのものを直接話法で書く。** ✗「記事は〜と書いている」「記事は〜を前提している」（紹介文になっており、そのまま引用できない）/ ✓「AIツールの多くがPythonで書かれているから、Pythonは学ぶ価値がある」。記事からの引用を長く貼らず、自分の言葉で詰める。',
          ),
        counter: z
          .string()
          .describe(
            '同じ論点に**こう返せる**（反対の立場）。**50字以内を厳守。** claim と同じく直接話法で書く（「記事は〜」で始めない）。**claim と必ず噛み合わせる**——別の話題の指摘や、記事と同じ立場の補強を書いてはいけない。藁人形にせず、実際にその立場を取る人が言うことを書く。',
          ),
        counterInArticle: z
          .boolean()
          .catch(false)
          .describe(
            'その反論が記事の中に書かれているなら true。記事の外から補ったなら false（画面に「記事の外」と出るので、読者が記事の主張として引用してしまうのを防げる）。',
          ),
      }),
    )
    .describe(
      '争点を論点ごとに分解した対。2〜3組。**成り立つ条件・崩れる条件は独立させず、この対の中に入れる**（「小規模なら前者、CI が遅いチームなら後者」）。賛否の本質は正誤ではなく優先順位の違いなので、その分かれ目が対の中に出る。',
    ),
  firsthand: z
    .array(
      z.object({
        angle: z
          .string()
          .describe(
            '書ける切り口の**名前だけ**。25字以内。**文にしない。主張を書かない。** ✗「レビューの自動化には慎重であるべきだ」/ ✓「生成量とレビュー負荷の実測」',
          ),
        why: z
          .string()
          .describe(
            '**なぜこの読者がそれを言えるのか。** 60字以内。読者プロフィールにある技術・立場・日常の作業と結びつけ、「どこが読者にとって一次情報になるか」を書く。意見そのものは書かない。例:「同じ構成を業務で毎日動かしているので、手戻りの頻度を実測値として出せる」',
          ),
      }),
    )
    .describe(
      '読者が自分の経験からこの争点に足せること。1〜3組。**発信の最大の障壁は「これを自分が言っていいのか」なので、切り口だけでなく必ず根拠（why）を対で書く。** 読者プロフィールとの接点が本当に無ければ空配列にする。ひねり出さない。',
    ),
  verify: z
    .array(z.string())
    .describe(
      '読者が自分の環境で主張の真偽を確かめる方法。**0〜2個**、各60字以内。手順やコマンド。確かめようが無い主張なら空配列。',
    ),
});

/**
 * コミュニティの「登壇できる」枠だけに通す判定。
 *
 * ルールベースでは「LT」「登壇者募集」の語で拾うところまでしかできない。
 * まだ募集しているのか、何を何枠募集しているのか、締切はいつかは
 * イベント説明の本文に埋まっているので、そこだけ読ませる。
 *
 * 参加系（勉強会・もくもく会）には通さない。日時・場所・定員は API が
 * 構造化データで返すので、要約を通すと情報が減る。
 */
export const CommunitySpeakResultSchema = z.object({
  items: z
    .array(
      z.object({
        ref: z.number().int().describe('入力に付与した番号'),
        isOpen: z
          .boolean()
          .describe(
            '**いま登壇者・発表者を募集しているか。** 過去の登壇募集の報告、LT を聞くだけの回、' +
              '募集が締め切られたもの、登壇ではなく参加の募集は false。判断に迷うときは false。',
          ),
        callFor: z
          .string()
          .nullable()
          .describe(
            '何を何枠募集しているか。原文の数字をそのまま使う。例:「LT 5分 × 6枠」「トーク 20分 / 40分」。' +
              '本文から読み取れないときは null。埋めるために推測しないこと。',
          ),
        deadlineAt: z
          .string()
          .nullable()
          .describe(
            '応募の締切。YYYY-MM-DD 形式。本文に書かれていなければ null（開催日で代用しないこと）。',
          ),
        angles: z
          .array(z.string())
          .describe(
            'この読者がこのイベントで出せる題材の**名前だけ**を並べる。**文にしない。** ' +
              '読者プロフィールにある技術スタックと、そのイベントの主題が重なるところを名詞句で書く。' +
              '例:「Server Components の実務での落とし所」「AI エージェント併用時のレビュー負荷の実測」。' +
              '「〜すべきだ」「〜だと言える」のような主張や、発表の下書きは禁止。' +
              '重なりが無ければ空配列にする。0〜3個。',
          ),
      }),
    )
    .describe('入力されたすべての ref に対して1件ずつ'),
});

export type ScoreResult = z.infer<typeof ScoreResultSchema>;
export type CommunitySpeakResult = z.infer<typeof CommunitySpeakResultSchema>;
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
export type TalkDescribeResult = z.infer<typeof TalkDescribeResultSchema>;
/** 要約段の 1 件ぶん。talk レーンだけ debate* が乗る */
export type DescribeItem = DescribeResult['items'][number] &
  Partial<TalkDescribeResult['items'][number]>;
export type KnowDeepDiveResult = z.infer<typeof KnowDeepDiveSchema>;
export type BuildDeepDiveResult = z.infer<typeof BuildDeepDiveSchema>;
export type TalkDeepDiveResult = z.infer<typeof TalkDeepDiveSchema>;
export type DigestSummaryResult = z.infer<typeof DigestSummarySchema>;
