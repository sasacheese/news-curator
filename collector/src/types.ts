export type SourceKind =
  | 'qiita'
  | 'zenn'
  | 'hatena'
  | 'hackernews'
  | 'devto'
  | 'github_release'
  | 'github_repo'
  | 'changelog'
  | 'rss'
  | 'x';

export interface Metrics {
  likes?: number;
  stocks?: number;
  stars?: number;
  points?: number;
  comments?: number;
  hatena?: number;
  /** X のリポスト。人気度では likes より重く見る */
  reposts?: number;
  /** X の返信。comments と同じものとして扱う */
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  /** 表示回数。桁が違うので人気度の計算には使わない */
  impressions?: number;
}

/**
 * 記事の書き手。
 * Qiita / Zenn / dev.to は一覧 API のレスポンスに含まれているので、
 * 追加リクエストなしで取得できる。RSS などは名前だけ。
 */
export interface AuthorDetail {
  name: string;
  handle?: string;
  url?: string;
  avatarUrl?: string;
  bio?: string;
  organization?: string;
  location?: string;
  followers?: number;
  posts?: number;
  links?: { label: string; url: string }[];
}

/** 収集直後の生アイテム */
export interface RawItem {
  id: string;
  source: SourceKind;
  sourceLabel: string;
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  authorDetail?: AuthorDetail;
  tags: string[];
  /** 一覧表示や事前スコアリングに使う短い抜粋 */
  snippet: string;
  /** 取得できていればプレーンテキスト化した本文 */
  body?: string;
  metrics: Metrics;
  lang: 'ja' | 'en' | 'unknown';
  /** ソース定義側で与えた基礎点（RSS の weight など） */
  sourceWeight: number;
  /**
   * 本文とは別のリンク（X の投稿が指している記事など）。
   *
   * 深掘りで本文を補うときに、ここだけを取りに行く。ステータス URL 自体は
   * ログイン壁の向こうなので取らない。過去のダイジェストには無い。
   */
  linkedUrls?: string[];
  /** フィード側で与えた分類（watchlist の category）。今は 'security' だけ */
  feedCategory?: string;
  /** 重複排除でまとめた際に、どのソースから見つかったか。話題性の判定に使う */
  foundIn?: SourceKind[];
  /**
   * サムネイル画像の URL（配信元を直接参照する）。
   *
   * 深掘り対象になった記事にだけ、書き手が自分で置いた画像があるときだけ入る。
   * タイトルを描いただけの自動生成カードは image.ts で落としているので、
   * 大半の記事では undefined のまま——**無いほうが既定**。
   */
  imageUrl?: string;
}

export interface PreScoredItem extends RawItem {
  preScore: number;
  /**
   * 他のエンジニアと共通の話題になりうるか。
   *
   * 24 時間ぶんしか見ていないので「世間的に話題」は本来まだ確定しない。
   * 判定できるのは「そのプラットフォームの当日として明らかに伸びている」まで。
   * 一番強い根拠ははてブのホットエントリー掲載で、これは定義上そこに載った時点で話題。
   */
  buzz: boolean;
  /** その日・そのソース内での人気の順位（0〜1）。指標を持たないソースは 0.5 */
  popularityPercentile: number;
  matchedTopics: string[];
}

/**
 * キュレーションのレーン。読者が持つ目的にそのまま対応する。
 *
 * ひとつの「価値スコア」に畳むと、いちばん測りやすい指標——このツールでは
 * 関心トピックとのキーワード一致——だけが残る。実測で掲載記事の 43% が
 * 単一プロダクトの話に偏ったのはそれが原因だった。目的ごとに別の証拠を使い、
 * 別の予算を与える。
 *
 * - security: 企業の情報漏洩・攻撃の事案。攻撃手段と、個人・企業の対策まで書く専用枠。
 *          セキュリティ系のフィード由来か、見出しに事案の語彙があるものだけが入る。
 * - know : 知る。規模の大きい話。影響範囲 × 取り返しのつかなさで測る。
 *          読者の関心と独立に成立するので、トピック一致を判定に使わない。
 * - build: 作る。試したくなるもの。可能性の差分 × 触れる実体で測る。
 *          新しいものほど語彙に無いので、ここでも一致は主軸にしない。
 *          どのレーンにも寄らなかったものはここに入る（既定のレーン）。
 */
export const LANES = ['security', 'know', 'build'] as const;
export type Lane = (typeof LANES)[number];

/**
 * security 以外のレーン。「その他の注目記事」を等分する母数はこちら。
 *
 * security は後から足した専用枠で、件数の予算を別に持つ（config の security*）。
 * 等分の母数に入れると、既存のレーンの枠が黙って減る。
 */
export const GENERAL_LANES = ['know', 'build'] as const;

/** 実行ログ・LLM への指示・画面で共通の表示名 */
export const LANE_LABELS: Record<Lane, string> = {
  security: 'セキュリティ',
  know: '知る',
  build: '作る',
};

/** 読んだ結果として何が得られるか。時間対効果の「リターン」側。 */
export const PAYOFFS = ['apply', 'decide', 'aware'] as const;
export type Payoff = (typeof PAYOFFS)[number];

/**
 * この情報がどれくらい保つか。
 *
 * 「今日読む価値」だけで採点すると旬の使いこなし Tips が上位を占める。
 * 実測でベスト3が2日とも「Claude Code のトークン節約術」「サブエージェント並列は
 * お得か」の類で埋まり、同じ日に出ていた Vite 8 や TypeScript の言語機能が
 * 下に沈んでいた。長期価値を別の軸として持たせて、枠を確保できるようにする。
 */
export const DURABILITIES = ['foundational', 'durable', 'ephemeral'] as const;
export type Durability = (typeof DURABILITIES)[number];

/** LLM によるランク付け結果 */
export interface RankedItem extends PreScoredItem {
  score: number;
  /**
   * そのまま貼って試し始められるプロンプト（その他候補の枠で使う）。組めなければ null。
   *
   * URL が GitHub のリポジトリや npm のパッケージを指しているときだけ、身元から
   * テンプレートで組む（try-prompt.ts）。記事（Qiita / Zenn / はてな / HN）からは
   * 身元が取れないので必ず null になる。ベスト3のカードはこれを使わず、
   * deep.tryPrompt に LLM が書いたものを持つ。
   */
  tryPrompt?: string | null;
  /**
   * 画面の見出しに出す日本語のタイトル。原題が日本語のときは null。
   *
   * カードの見出しは元記事のタイトルそのものだが、GitHub のトレンドや
   * 海外の記事は題が英語のままで、日本語の要約が並ぶ画面でそこだけ読めない
   * （「owner/repo — English description」の形が特にひどい）。原題は
   * title に残したまま、見出しだけ日本語に差し替えるためのフィールド。
   */
  titleJa: string | null;
  oneLiner: string;
  /**
   * 「3行で要約」。専門用語・固有名詞を使わずに、記事が何を言っているかだけを書く。
   *
   * 深掘りカードの summary とは**書く語彙が違う**。あちらは記事の語彙をそのまま使って
   * 詳しく書き（分からない語は prerequisites でその場で開ける）、こちらは開かなくても
   * 誰でも読めることだけを引き受ける。以前は 1 つの `reason` が両方を兼ねようとして、
   * 結果どちらでもない中間の文になっていた。
   */
  takeaways: string[];
  keywords: string[];
  category: string;
  /** どの目的で選ばれたか。選定・表示の単位 */
  lane: Lane;
  /**
   * security レーンのときだけ入る事案の名寄せキー（「被害組織 事案の種類」）。
   * 同じ事案の記事を 1 件にまとめ、日をまたいで続報を追うのに使う。他のレーンでは無い。
   */
  incident?: string | null;
  /** 元記事の読了目安（分）。時間対効果の「コスト」側 */
  readingMinutes: number;
  payoff: Payoff;
  /** この情報がどれくらい保つか。ベスト3の枠確保に使う */
  durability: Durability;
}

/** 記事を読む前に押さえておくべき知識 */
export interface Prerequisite {
  term: string;
  /** 記事のどこで詰まるか。「なぜこの説明が要るのか」を読者に示す */
  stumblingPoint: string;
  explanation: string;
}

/** LLM の使用量。実測にもとづいてコストを判断するために記録する */
export interface UsageStat {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  /** その段にかかった実時間の合計（並列実行するので壁時計とは一致しない） */
  elapsedMs: number;
}

export interface UsageReport {
  stages: Record<string, UsageStat>;
  totalCostUsd: number;
}

/**
 * 記事の要点を図にしたもの。
 *
 * どれも「無理にチャートにしない」方針で選んでいる。
 * - comparison: 変更前後の対比。テキストの対比なのでチャートではなく 2 カラム表
 * - flow: 処理や手順の流れ。ステップ図
 * - metrics: 数値の改善。2 本だけの棒グラフはアンチパターンなので stat tile
 * - architecture: 何がどこを経由してどこへ届くか。層を縦に積む
 */
export type Visual =
  | {
      type: 'comparison';
      title: string;
      beforeLabel: string;
      afterLabel: string;
      rows: { aspect: string; before: string; after: string }[];
    }
  | {
      type: 'flow';
      title: string;
      steps: { label: string; detail: string }[];
    }
  | {
      type: 'metrics';
      title: string;
      items: {
        label: string;
        value: string;
        baseline: string | null;
        /** 値が増えるのが良いのか悪いのか。矢印の向きと色に使う */
        direction: 'up-good' | 'down-good' | 'neutral';
        note: string | null;
      }[];
    }
  | {
      /**
       * 構成図。「何がどこを経由してどこへ届くか」。
       * 任意のグラフにはしない——座標を生成させると線が交差して読めなくなるので、
       * 上から下へ積む層に限っている。描画は層の数だけで一意に決まる。
       */
      type: 'architecture';
      title: string;
      layers: {
        label: string;
        nodes: {
          name: string;
          note: string | null;
          /** 記事が論じている当のもの。「構成のどこの話か」を示す */
          highlight: boolean;
        }[];
        /** 次の層へ何が渡るか。最後の層は null */
        via: string | null;
      }[];
    };

/**
 * 記事の中で使われていた画像を、解説の中で引用したもの。
 *
 * カード上部のサムネイル（RawItem.imageUrl）とは目的が違う。サムネイルは「どの記事か」を
 * 示す 1 枚で、中身は読まなくてよい。こちらは書き手が説明のために置いた画像——実行結果の
 * スクリーンショット、構成の図解、計測のグラフ——なので、**読むためにある**。
 * 何を指しているのかは caption が引き受け、画像が消えたときは画面側で枠ごと畳む。
 */
export interface Figure {
  /** 配信元の画像 URL（取り込まずにホットリンクする。理由は image.ts 冒頭） */
  url: string;
  /** 記事側の alt か figcaption。無い記事が多いので空のことがある */
  alt: string;
  /** その画像が何を示しているか。解説の文脈で書く（alt の写しではない） */
  caption: string;
}

/**
 * 深掘りカードの共通部分。
 *
 * 差分（何が変わるか / 何ができるようになるか）はレーンごとに 1 項目へ統合してある。
 * どのレーンも見ているのは同じ差分で、見る向きが違うだけ。
 *
 * - know : 自分への影響として見る → impact
 * - build: 可能性の広がりとして見る → unlocks（「これまで◯◯ → これから△△」の形）
 *
 * headline は廃止した。oneLiner・takeaways・summary と 4 つ目の要約になっていて、
 * 実測で 1 つの事実が 5 箇所に書かれていた。カードの見出しは元記事のタイトルにする。
 */
export interface DeepDiveBase {
  /**
   * 記事の内容の要約。**記事の語彙をそのまま使って詳しく書く。**
   *
   * 平易さは takeaways（3行で要約）が引き受けるので、ここでは易しくしない。
   * 分からない語は prerequisites がその場で開ける形で補う——だから
   * prerequisites.term は「summary で自分が使った語」と揃えさせている。
   */
  summary: string;
  prerequisites: Prerequisite[];
  visual: Visual | null;
  /**
   * 記事の中で使われていた画像のうち、解説で引用したもの。0〜2 枚。
   *
   * 引用するのは「文章より画像のほうが早い」ものだけなので、**空が既定**。
   * 記事に画像が無い日も、装飾しか無い日も空になる。
   */
  figures: Figure[];
  code: { lang: string; caption: string; content: string } | null;
  relatedLinks: { label: string; url: string }[];
  readingMinutes: number;
}

/** 知る: 読者が知りたいのは使い方ではなく「自分がどう巻き込まれるか」 */
export interface KnowDeepDive extends DeepDiveBase {
  lane: 'know';
  /**
   * この記事が関係する人（画面では「関係がある人」）。
   * 「〜な人」の形で淡々と並べる。影響の内容は書かない——該当するかを
   * 目で拾うためだけの一覧で、内容は summary の仕事。
   */
  impact: string[];
  /** 日付が本体の情報だけ。1 行ずつ。報道の経緯ではなく読者の期限 */
  timeline: string[];
  /**
   * 読者がいま取るアクション（画面では「必要なアクション」）。
   * 該当するか調べるコマンド・見るべき設定・暫定回避。「試す」ではなく「確認して対処する」。
   */
  checkNow: string[];
  /** 進行中の事象で、事実と推測の境目。確定していないことを確定として書かせない */
  unknowns: string[];
}

/** 作る: 読者はこのカードを読んでそのまま手を動かす */
export interface BuildDeepDive extends DeepDiveBase {
  lane: 'build';
  /**
   * できるようになること。**読んだ人が「試したい」と思う一点だけ。**
   *
   * 仕組みの説明ではなく、読者が絵として思い描ける具体を書かせている。
   * 実測で「CAD 編集を MCP 経由のエージェントにも型付き・承認制で開放できる」のような
   * 仕組みの列挙が返っていた——正しいが、これを読んで手は動かない。
   */
  unlocks: string[];
  howToTry: string[];
  /**
   * 「自分に効くか」を読者が YES / NO で答えられる条件（画面では「使える場面」）。
   *
   * 以前は「向いている場面」で、人物像（「効率化したい開発者」）が返ってきていた。
   * それは誰にでも当てはまるので判定に使えない。観測できる状態で書かせる。
   */
  fitFor: string[];
  /**
   * 当てはまったら読まなくてよい条件（画面では「向かない場面」）。
   * 使えない（未対応）ものと、使えるが不適なものの両方が入る。
   */
  notFor: string[];
  /**
   * 最重要の 1 つだけ（画面では「注意点」）。
   *
   * 知らずに始めると詰まる・想定外に金がかかる・壊れる、のどれかに当たるもののうち、
   * いちばん起こりやすく損害が大きいものを 1 つ。仕様の細部（非推奨警告、上限値）は
   * ここではない——実測でそれが混ざり、本当に詰まる 1 件が埋もれていた。
   */
  caveats: string[];
  /**
   * 「試し方」を、そのまま貼って試し始められるプロンプトの形にしたもの。
   *
   * 4 節（試すこと / 手順 / 確認したいこと / 前提・注意）に固定してある
   * （try-prompt.ts の TRY_PROMPT_HEADINGS）。形が崩れていれば null に落ち、
   * 画面は howToTry の箇条書きから組んだ代替を出す。動かす対象が無い記事も null。
   */
  tryPrompt: string | null;
}

/** 攻撃の段階。記事から読み取れた段階だけを並べる */
export const ATTACK_STAGES = [
  'initial-access',
  'privilege-escalation',
  'lateral-movement',
  'exfiltration',
  'impact',
  'other',
] as const;
export type AttackStage = (typeof ATTACK_STAGES)[number];

export const DEFENSE_KINDS = ['tech', 'ops', 'org'] as const;
export type DefenseKind = (typeof DEFENSE_KINDS)[number];

/**
 * セキュリティ: 事案を「何が起きたか → どう攻められたか → 何をすればよいか」で読む。
 *
 * 対策は個人と企業で分ける。同じ事案でも、個人が今日やること（パスワード変更・
 * 通知の確認）と、企業が仕組みとして入れること（MFA の強制・ログ監視）は
 * 粒度も主語も違うので、混ぜると両方とも読めなくなる。
 */
export interface SecurityDeepDive extends DeepDiveBase {
  lane: 'security';
  /** 何が起きたか。企業・規模・時系列を 1 行ずつ */
  whatHappened: string[];
  /** 攻撃の流れ。記事から読み取れた段階だけ */
  attackChain: { stage: AttackStage; detail: string }[];
  /** 個人が今日やること */
  personal: string[];
  /** 企業が入れること。技術・運用・組織に分ける */
  organization: { kind: DefenseKind; action: string }[];
  /** 読者に関係があるかの判断材料 */
  relevance: string[];
  /** まだ確定していないこと */
  unknowns: string[];
  /** 続報のとき、前回から変わったこと。初報なら null */
  whatsNew: string | null;
}

export type DeepDive = SecurityDeepDive | KnowDeepDive | BuildDeepDive;

export interface TopItem extends RankedItem {
  rank: number;
  deep: DeepDive;
}

/**
 * リリース情報。
 *
 * 「知っているか知らないか」だけで差が出る種類の情報なので、
 * ランキングせずに全件出す。ベスト3とは別枠。
 */
export const RELEASE_KINDS = ['ai-model', 'major', 'minor', 'patch', 'service'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

/**
 * そのリリースで読者に何が起きるか。
 *
 * kind（メジャー/マイナー/パッチ）は仕様上の分類で、読み手の関心とずれる。
 * 実測 27 件では service 15 件の中に「1 サンドボックスで複数エージェント実行」と
 * 「Server-Timing ヘッダーの通過」が同居し、minor のほうが「できるようになる」
 * 打率が高かった（4 件中 3 件）。並べる軸はこちらにする。
 */
export const RELEASE_IMPACTS = ['unlocks', 'security', 'improves', 'chore'] as const;
export type ReleaseImpact = (typeof RELEASE_IMPACTS)[number];

/**
 * 代表にまとめられた、同じ製品の他の項目。
 *
 * 2 種類が入る。どちらも「1 行に畳んで、開けば個別に辿れる」で足りるので同じ形にした。
 * - モノレポが同時リリースした関連パッケージ
 * - 同じ製品について同日に出た別の告知（Vercel Changelog などが 1 日に複数出す）
 */
export interface ReleaseAlso {
  label: string;
  url: string;
}

/** 脆弱性の情報。GitHub Security Advisories 由来のときだけ入る */
export interface ReleaseAdvisory {
  /** CVE-2026-53609 など。割り当て前は null */
  cveId: string | null;
  /** GHSA-xxxx-xxxx-xxxx */
  ghsaId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** CVSS スコア。取れなければ null */
  cvss: number | null;
  /** 影響を受けるパッケージ名 */
  packageName: string;
  /** 修正が入った最初のバージョン。未修正なら null */
  patchedVersion: string | null;
}

export interface ReleaseItem {
  id: string;
  /** 製品・ライブラリ名 */
  product: string;
  /** その製品が何をするものか。1文。判別できなければ null */
  what: string | null;
  version: string | null;
  kind: ReleaseKind;
  /** 読者に何が起きるか。並べ替えと折りたたみの判断はこれで行う */
  impact: ReleaseImpact;
  /**
   * 「〜できるようになる」の1文。新しくできることが無ければ null。
   * null のときは impact を chore に落とす（分類とテキストを食い違わせない）。
   */
  unlock: string | null;
  /** 変化の大きさを差分で見せる。どちらも取れたときだけ出す */
  change: { before: string; after: string } | null;
  /** 新たに対応した環境。「スマホでも使えるようになった」を一目で分かるようにする */
  scope: string[];
  /** 脆弱性情報。impact が security のときだけ入る */
  advisory?: ReleaseAdvisory;
  /** 何が入ったか。1〜2文 */
  summary: string;
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt: string;
  /** 代表にまとめた同じ製品の他の項目 */
  alsoReleased: ReleaseAlso[];
  /**
   * そのまま貼って試し始められるプロンプト。組めなければ null。
   *
   * URL が GitHub のリリースやリポジトリを指しているときに、身元からテンプレートで組む。
   * 公式ブログの告知や料金改定からは身元が取れないので null になる。
   */
  tryPrompt?: string | null;
}

/**
 * テックコミュニティの情報（イベント・登壇募集・もくもく会）。
 *
 * 記事ともリリースとも軸が違う。記事は publishedAt（過去）が本体だが、
 * これは開催日と締切（未来）が本体なので、公開ウィンドウで引くと
 * 「3 週間前に告知され、明日が応募締切の CFP」——この枠でいちばん行動価値が
 * 高いもの——が構造的に落ちる。ウィンドウを広げる話ではなく、引く軸が違う。
 *
 * そのため「その日の差分」ではなく**盤面**として持つ。開催まで毎日出るのが
 * 正しいので、記事の重複排除（loadSeenUrls）や検索インデックスには通さない。
 * 代わりに前日との差を isNew で見せる。
 *
 * 日次ダイジェストには入れない（data/community.json に 1 ファイルで持つ）。
 * 流動性が高く、その日の記録として残す意味が無いためで、日次に埋めると
 * 同じ 12 件が毎日コミットされ、過去日を開いたときに終わったイベントが並ぶ。
 */
export const COMMUNITY_ACTIONS = ['speak', 'attend', 'work'] as const;
export type CommunityAction = (typeof COMMUNITY_ACTIONS)[number];

export const COMMUNITY_ACTION_LABELS: Record<CommunityAction, string> = {
  speak: '登壇できる',
  attend: '参加する',
  work: 'もくもく',
};

/**
 * イベントの規模。距離フィルタを緩める判断に使う。
 *
 * 近所しか出さないと TSKaigi / JSConf / ISUCON が構造的に落ち、全国を出すと
 * 行けないもくもく会で埋まる。規模が距離の免除条件になる。
 */
export const COMMUNITY_SCALES = ['conference', 'meetup', 'recurring'] as const;
export type CommunityScale = (typeof COMMUNITY_SCALES)[number];

export interface CommunityDeadline {
  /** 何の締切か。cfp = 登壇応募 / apply = 参加申込 */
  kind: 'cfp' | 'apply';
  at: string;
  /**
   * 生成日を基準にした残り日数。画面で計算し直さない。
   * 過去日のダイジェストを開いたときに「残り -40 日」を出さないため、
   * その日の見え方をそのまま保存する。
   */
  daysLeft: number;
}

export interface CommunityItem {
  id: string;
  action: CommunityAction;
  title: string;
  url: string;
  /** 主催コミュニティ。connpass の series / Doorkeeper のサブドメイン */
  organizer: string | null;
  startsAt: string;
  /** 複数日開催のときだけ。単日は null */
  endsAt: string | null;
  venue: {
    mode: 'online' | 'onsite' | 'hybrid';
    place: string | null;
    /** 都道府県。住所から引く。オンラインのみなら null */
    prefecture: string | null;
    /** 国。海外の現地開催を落とすために持つ */
    country: string;
  };
  /** 締切。定例のもくもく会など、無いものは null */
  deadline: CommunityDeadline | null;
  scale: CommunityScale;
  /** 定員・参加確定・補欠。「もう埋まっている」を出すために要る。取れないソースは null */
  capacity: { limit: number | null; accepted: number | null; waiting: number | null } | null;
  /** 何のイベントか。1 文・60 字 */
  what: string;
  /** speak のときだけ: 何を募集しているか（「LT 5 分 × 6 枠」）。読み取れなければ null */
  callFor: string | null;
  /**
   * speak のときだけ: 読者のプロフィールから出せる題材。
   * **名詞句だけ**を並べ、文にしない。文にすると LT の代筆になる。
   * 後処理は llm.ts の looksLikeOpinion を通す（文で返ってきたものは落とす）。
   */
  angles: string[];
  /** 前日のダイジェストに無かった = 今日はじめて盤面に乗った */
  isNew: boolean;
  sourceLabel: string;
  matchedTopics: string[];
}

/**
 * コミュニティの盤面（data/community.json）。毎回まるごと差し替える。
 *
 * 日次ダイジェストと違って履歴を残さない。開催が過ぎたイベントに価値は無く、
 * 「いつ告知されたか」も読者の行動に効かないため。
 */
export interface CommunityBoard {
  updatedAt: string;
  /** 生成日（JST）。CommunityItem.deadline.daysLeft の基準日 */
  date: string;
  items: CommunityItem[];
  /** 行動ごとの件数。どの枠が薄いのか後から追えるように残す */
  byAction: Record<string, number>;
  /** 縮退（connpass のキーが無いなど）を読み手に伝える */
  notes: string[];
}

export interface Digest {
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  /** 冒頭に置く3〜5行の案内文。ベスト・リリース・その他から合成する */
  summary: string[];
  /**
   * サマリーの最後に置く「この先の見立て」。直近数日の流れからの推測なので、
   * サマリー本体とは別枠で持つ。LLM 未設定・生成失敗の日は null。
   */
  outlook: string | null;
  top: TopItem[];
  releases: ReleaseItem[];
  others: RankedItem[];
  stats: {
    collected: number;
    afterDedupe: number;
    afterPreScore: number;
    ranked: number;
    bySource: Record<string, number>;
    /** レーンごとの掲載件数。偏りを後から追えるように残す */
    byLane: Record<string, number>;
    estimatedReadMinutes: number;
  };
  topics: string[];
  models: { rank: string; summary: string };
  usage: UsageReport;
  notes: string[];
}

/** 検索用の軽量インデックス（月別シャード） */
export interface IndexEntry {
  id: string;
  date: string;
  rank: number | null;
  title: string;
  /** 日本語の見出し。原題が日本語の記事とリリース情報では null */
  titleJa: string | null;
  url: string;
  source: SourceKind;
  sourceLabel: string;
  summary: string;
  keywords: string[];
  topics: string[];
  category: string;
  /** どの目的で選ばれたか。リリース情報など該当しないものは null */
  lane: Lane | null;
  score: number;
  publishedAt: string;
  lang: string;
}

export interface Manifest {
  updatedAt: string;
  latest: string | null;
  dates: string[];
  months: string[];
  /**
   * 生成元リポジトリ（owner/repo）。UI から設定ファイルの編集画面へ飛ぶために使う。
   * ホスト名からは推測できない（Cloudflare Pages などに移した時点で破綻する）ので、
   * 生成側で GITHUB_REPOSITORY を記録しておく。
   */
  repo: string | null;
}

/**
 * リリース情報の監視対象。
 *
 * 「どこを見るか」は運用中に増減するので、チューニング項目（sources.json）とは
 * 分けて config/watchlist.json に置き、GitHub の Web エディタから直接編集できるようにしている。
 */
export interface Watchlist {
  repos: string[];
  feeds: { label: string; url: string; weight: number; category?: string }[];
  changelogs: { label: string; url: string; homepage: string }[];
}

export interface Topic {
  name: string;
  weight: number;
  keywords: string[];
}

export interface TopicsConfig {
  profile: string;
  topics: Topic[];
  exclude: { keywords: string[] };
}

/* ------------------------------------------------------------------ *
 * 発掘（Radar）
 *
 * 「このライブラリ、あんまり話題じゃないけど便利ですよ」「これ海外で話題だけど
 * 日本ではまだ誰も使ってない」を人に言えるようにするための枠。
 *
 * 記事でもリリースでもイベントでもなく、**道具そのもの**を単位にする。
 * これは記事のパイプラインでは原理的に作れない。記事の枠は「今日公開されたか」で
 * 引くが、ここで欲しいのは「その道具が今どういう状態にあるか」で、それは
 * ある 1 日の出来事ではなく**2 つの物差しの差**として現れるからだ。
 *
 *   海外の熱   … npm の週間ダウンロード数、GitHub のスター、英語圏での言及回数
 *   国内の厚み … Qiita の記事数、Zenn の記事数、日本語での言及回数
 *
 * 差が大きいものだけを出す。差が無いもの（両方厚い）は既に知られているので
 * 紹介する価値が無く、両方薄いものはまだ実体が無い。
 * ------------------------------------------------------------------ */

/**
 * 発掘の判定。
 *
 * 読者が言いたい 2 つの台詞にそのまま対応させている。台詞が違うので、
 * 根拠にする信号も違う。
 *
 * - early : 「海外で今話題になっているけど日本ではまだ」
 *           → **勢い**で測る。伸び率・直近の英語圏での言及・更新の新しさ。
 * - hidden: 「あんまり話題じゃないけどめっちゃ便利」
 *           → **定着**で測る。話題性ではなく、実際に使われている量そのもの。
 *
 * 「両方薄い」は出さない。まだ実体が無いものを人に紹介すると外すので、
 * どちらかの証拠は必ず要求する。
 */
export const RADAR_VERDICTS = ['early', 'hidden'] as const;
export type RadarVerdict = (typeof RADAR_VERDICTS)[number];

export const RADAR_VERDICT_LABELS: Record<RadarVerdict, string> = {
  early: '海外で先行',
  hidden: '静かに使われている',
};

/** 画面と実行ログで共通の説明。「なぜこの枠に入っているのか」を読者に示す */
export const RADAR_VERDICT_LEADS: Record<RadarVerdict, string> = {
  early:
    '海外で勢いがあるのに、日本語の記事がまだ少ないもの。' +
    '「海外で話題になってますよ」と言える段階です。',
  hidden:
    'どこでも話題になっていないのに、実際にはかなり使われているもの。' +
    '「知られてないけど便利」と言える段階です。',
};

/**
 * 道具 1 つぶんの計測値。
 *
 * すべて null 可。外部 API は落ちるし、npm に無い道具も GitHub に無い道具もある。
 * **測れなかったことと 0 だったことを混同しない**——「Qiita の記事数 0 本」は
 * 強い主張（誰も書いていない）だが、「測れなかった」はただの欠測で、
 * それを 0 と扱うと存在しない発見を報告してしまう。
 */
export interface RadarMeasure {
  /* --- 海外の熱 --- */
  githubRepo: string | null;
  githubStars: number | null;
  /** 最後に push された日時。現役かどうかの判定に使う */
  githubPushedAt: string | null;
  /**
   * アーカイブ済みか。
   * 人に紹介したあとで「それ開発終わってますよ」と返されるのが最悪の壊れ方なので、
   * 判定の最初にここで落とす。
   */
  githubArchived: boolean | null;
  npmPackage: string | null;
  /**
   * npm レジストリ上の最新バージョン。
   *
   * これを画面に出すのは、**間違ったパッケージを測っていないか読者が目で確かめる**
   * ため。実測で LLM が「TanStack Router」に `@tanstack/router` を割り当てたが、
   * それは 0.0.1-beta.53 で止まった別物だった（本体は @tanstack/react-router）。
   * 名前が実在する以上、機械では見分けられない——だから隠さずに出す。
   */
  npmVersion: string | null;
  /** 非推奨として公開されているか。非推奨のものは人に紹介してはいけない */
  npmDeprecated: boolean | null;
  /** 週間ダウンロード数。「話題」ではなく「実際に使われている量」を測れる唯一の指標 */
  npmWeekly: number | null;
  /**
   * 直近 7 日 ÷ その前の 7 日。1.0 で横ばい。
   * 単発のリクエストで勢いが取れるので、履歴が無い初日から使える。
   */
  npmTrend: number | null;
  /** 過去 90 日のダイジェストで、英語の記事に出てきた回数 */
  abroadMentions: number;

  /* --- 国内の厚み --- */
  /** Qiita でこの語に言及している記事数 */
  qiitaArticles: number | null;
  /**
   * Qiita の数え方。
   *
   * 既定はフレーズ検索（`mention`）で、言及した記事を数える。ただし道具の名前が
   * 英語の一般語と同じ綴りのときは、それでは無関係な記事を大量に数えてしまう
   * （実測: Effect のフレーズ検索は 12,342 件、タグは 31 件）。その場合は
   * タグ検索（`tag`）に切り替える。
   */
  qiitaMethod: 'mention' | 'tag' | null;
  /** Zenn の記事数 */
  zennArticles: number | null;
  /**
   * Zenn の数え方。
   *
   * `topic` はトピックの正確な記事数。`search` は検索結果の件数で、
   * **1 ページぶんで打ち切られる**ので下限値でしかない（「TanStack Router」の
   * ように複数語の名前はトピックが存在せず、こちらに落ちる）。
   * 数字の意味が違うものを同じ顔で画面に出さないために記録する。
   */
  zennMethod: 'topic' | 'search' | null;
  /**
   * Zenn の件数が総数として確定しているか。
   *
   * 検索は 1 ページ 48 件で、続きがあるかは next_page で分かる。続きがあるときの
   * 件数は下限値でしかなく、**上から抑えられない**。「日本語ではまだ薄い」は
   * 上限の主張なので、抑えられないものは薄いと言ってはいけない。
   */
  zennComplete: boolean | null;
  /** 過去 90 日のダイジェストで、日本語の記事に出てきた回数 */
  domesticMentions: number;

  measuredAt: string;
}

/** 発掘 1 件。画面のカード 1 枚に対応する */
export interface RadarItem {
  id: string;
  /** 道具の名前。表記は LLM に正規化させる（oxlint → Oxlint） */
  name: string;
  verdict: RadarVerdict;
  /** 紹介価値の順位づけ。レーンのスコアとは無関係な別の尺度 */
  score: number;
  /** 何をする道具か。1 文・専門用語なし */
  what: string;
  /**
   * 同僚に言う一言。
   *
   * **評価語を禁止している**（「すごい」「最高」「革命的」「便利」）。
   * 評価は聞いた相手がするもので、こちらが言えるのは「何ができるか」と数字だけ。
   * 評価語を混ぜた紹介は、聞いた側から見ると中身が無い。
   */
  pitch: string;
  /** これで置き換えられる既存の道具。名詞だけ */
  insteadOf: string[];
  /** 最初に打つ 1 コマンド。確実に分かる形だけ。分からなければ null */
  firstStep: string | null;
  /** 「自分に効くか」を YES / NO で答えられる観測可能な条件 */
  fitFor: string[];
  /** 紹介する前に知っておくべき最重要の 1 点。無ければ null */
  caution: string | null;
  measure: RadarMeasure;
  /**
   * 判定の根拠を、数字を含んだ人の言葉で。
   *
   * **これがこの機能の本体。** 「Qiita 2 本 / Zenn 31 本に対して npm 週 1,355 万 DL」
   * という文がそのまま紹介の根拠になる。要約と違って、ここは生成させない
   * （計測値から機械で組み立てる）——数字を LLM に書かせると必ずずれる。
   */
  evidence: string[];
  links: { label: string; url: string }[];
  /** この語をダイジェストで最初に見かけた日 */
  firstSeenAt: string;
  /** 前回の盤面に無かった = 今日はじめて載った */
  isNew: boolean;
  /** どの記事から見つけたか */
  foundVia: { title: string; url: string } | null;
  /**
   * そのまま貼って試し始められるプロンプト。
   *
   * 発掘は npm と GitHub を実測して作った板なので、パッケージ名かリポジトリの
   * どちらかが必ず入っている。ほぼ全件に付く。
   */
  tryPrompt?: string | null;
}

/**
 * 発掘の台帳（data/radar-ledger.json）。
 *
 * 盤面（radar.json）とは別のファイルに分けている。台帳は語が増える一方で、
 * 画面は 10 件しか出さないので、同じファイルに入れると閲覧者が毎回
 * 数百件ぶんを転送することになる。台帳はブラウザからは読まない。
 *
 * 台帳が果たす役割は 3 つ。
 * - 名前解決（npm パッケージ名・GitHub リポジトリの特定）の結果を貯めて、同じ語に
 *   二度と LLM を使わない。「道具ではなかった」という否定の結果も貯める
 * - 再計測の間隔を管理して、外部 API の呼び出し数を一定に保つ
 * - 計測の履歴を残して、自分のデータで伸びを見られるようにする
 */
export interface RadarLedgerEntry {
  id: string;
  name: string;
  /** 名前解決の結果。null は「まだ解決していない」 */
  resolved: {
    /** 導入して使える道具か。概念・会社名・設定ファイル名は false */
    isTool: boolean;
    /**
     * 公式の表記に直した表示名（oxlint → Oxlint）。
     * 台帳のキーは `name` 側のまま動かさない——キーが変わると、同じ語を
     * 別の語として二重に持ち、計測も紹介文もやり直しになる。
     */
    displayName: string;
    npmPackage: string | null;
    githubRepo: string | null;
    what: string;
    /** 名前が英語の一般語と同じ綴りか。国内の記事数の数え方を切り替えるのに使う */
    nameIsCommonWord: boolean;
    at: string;
  } | null;
  measure: RadarMeasure | null;
  /** 計測の履歴。最大 8 点だけ残す（伸びを見るのに十分で、ファイルが膨らまない） */
  history: {
    at: string;
    npmWeekly: number | null;
    githubStars: number | null;
    /** そのときの国内の厚み（Qiita + Zenn） */
    domestic: number | null;
  }[];
  /**
   * 紹介文のキャッシュ。
   *
   * 盤面に載り続けているものへ毎日 LLM を使い直すのは無駄なだけでなく、
   * 文面が日替わりで変わって「昨日読んだもの」と繋がらなくなる。
   * 一度書けたら固定する。
   */
  pitch: {
    pitch: string;
    insteadOf: string[];
    firstStep: string | null;
    fitFor: string[];
    caution: string | null;
    at: string;
  } | null;
  mentions: { abroad: number; domestic: number };
  firstSeenAt: string;
  lastSeenAt: string;
  /** 盤面に初めて載った日。載っていなければ null */
  featuredAt: string | null;
  /**
   * 直近の判定。落とした理由も残す。
   * どの語がなぜ出てこないのかを後から追えないと、しきい値を調整できない。
   */
  lastVerdict: RadarVerdict | null;
  lastReason: string | null;
}

/**
 * 発掘の盤面（data/radar.json）。毎回まるごと差し替える。
 *
 * コミュニティ盤面と同じ扱いだが、寿命の考え方は逆。イベントは開催が過ぎたら
 * 価値が消えるが、道具は腐らない。なので期限で落とさず、**枠を有限にして**
 * スコアで押し出す。まだ試していないものが黙って消えないようにするため。
 */
export interface RadarBoard {
  updatedAt: string;
  date: string;
  items: RadarItem[];
  byVerdict: Record<string, number>;
  /** 台帳の規模。「何語を見て 10 件に絞ったのか」を画面に出すために持つ */
  stats: {
    ledgerSize: number;
    measuredToday: number;
    /** 道具ではないと判定して台帳に記録済みの語数 */
    notTool: number;
  };
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * 道具箱
 *
 * 記事ではなく**道具**を単位に、日をまたいで持つ台帳。選別より網羅が目的で、
 * 一覧が膨らみ続けないよう「新着のまま 7 日放置したら退避」「新しい信号が来たら再浮上」
 * の 2 つで見える量を抑える。消さない（退避したものも台帳と検索には残る）。
 *
 * 台帳（data/tools/ledger.json）は collector だけが読む。ブラウザが読むのは
 * 盤面（data/tools/board.json）だけ——発掘の台帳と盤面を分けているのと同じ理由。
 * ------------------------------------------------------------------ */

/** 種類。誤ラベルのリスクが低い軸として選んだ。判定はルールベースで、迷ったら other */
export const TOOL_KINDS = ['cli', 'library', 'skill', 'plugin', 'mcp', 'saas', 'cloud', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * 読者が付ける状態。new と archived だけは collector が付ける。
 * - interested: スマホで「気になる」を押した。PC で触る候補として盤面の先頭に出る
 * - prepared  : 下準備まで済んだ（下準備の仕組みは後続で入れる）
 * - tried     : 触った
 * - passed    : 見送った。理由は passReason
 */
export const TOOL_STATES = ['new', 'interested', 'prepared', 'tried', 'passed', 'archived'] as const;
export type ToolState = (typeof TOOL_STATES)[number];

/** 見送りの理由。似た道具の点数を下げるのに使う */
export const PASS_REASONS = ['have-equivalent', 'out-of-scope', 'too-costly', 'not-mature', 'other'] as const;
export type PassReason = (typeof PASS_REASONS)[number];

export interface ToolIdentity {
  npm?: string;
  /** owner/repo */
  github?: string;
  /** npm / GitHub で特定できないもの（SaaS・クラウドの新サービス・マーケットプレイスの項目） */
  url?: string;
}

/** 道具を見かけた記録。入口ごと・日ごとに 1 件 */
export interface ToolSignal {
  /** 入口の識別子（digest:top / digest:other / release / gh-trending / show-hn / radar / mcp-registry / …） */
  source: string;
  date: string;
  /** 0〜2。手で追加したもの > 深掘り > 一覧 > 急上昇の順 */
  strength: number;
  title?: string;
  url?: string;
  note?: string;
}

export interface ToolEntry {
  id: string;
  name: string;
  kind: ToolKind;
  identity: ToolIdentity;
  /** 開く先。GitHub / npm / 公式サイト */
  homepage: string;
  /** 何ができるか（1〜2 文）。LLM が書く。書けなかった日は元の説明文 */
  summary: string | null;
  /** 何の代わりになるか。分からなければ null */
  replaces: string | null;
  /** 試すのに要るもの（アカウント登録 / API キー / 有料 / OS など） */
  requires: string[];
  /** 信頼の目印。スキル・プラグイン・MCP は自分の環境でコードを動かすので必ず出す */
  trust: {
    official: boolean;
    author: string | null;
    stars: number | null;
    archived: boolean | null;
    license: string | null;
  };
  /** 元の説明文（GitHub の description / npm の description / 入口の説明） */
  description: string | null;
  signals: ToolSignal[];
  firstSeen: string;
  lastSignal: string;
  state: ToolState;
  stateAt: string;
  passReason?: PassReason | null;
  /** 退避から戻した日 */
  resurfacedAt?: string | null;
  /** 種類・信頼の情報を取りに行ったか（GitHub / npm を叩くのは 1 道具 1 回） */
  inspected: boolean;
  /** LLM の要約を試みたか（失敗しても毎日やり直さない） */
  described: boolean;
}

export interface ToolLedger {
  updatedAt: string;
  tools: Record<string, ToolEntry>;
}

export interface ToolBoardItem {
  id: string;
  name: string;
  kind: ToolKind;
  homepage: string;
  summary: string | null;
  replaces: string | null;
  requires: string[];
  trust: ToolEntry['trust'];
  state: ToolState;
  /** 盤面に出た理由の短い説明（どこで見かけたか） */
  seenIn: { source: string; date: string; title?: string; url?: string }[];
  firstSeen: string;
  lastSignal: string;
  isNew: boolean;
  resurfaced: boolean;
  score: number;
  tryPrompt: string | null;
}

export interface ToolBoard {
  updatedAt: string;
  date: string;
  /** 気になる・準備済み。PC で触る候補 */
  queue: ToolBoardItem[];
  /** 新着（退避していないもの）。種類ごとに画面で棚に分ける */
  items: ToolBoardItem[];
  /** 触ったもの。直近から */
  tried: ToolBoardItem[];
  byKind: Record<string, number>;
  stats: { ledger: number; archived: number; passed: number; addedToday: number; resurfacedToday: number };
  notes: string[];
}
