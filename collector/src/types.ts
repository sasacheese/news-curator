export type SourceKind =
  | 'qiita'
  | 'zenn'
  | 'hatena'
  | 'hackernews'
  | 'devto'
  | 'github_release'
  | 'github_repo'
  | 'changelog'
  | 'rss';

export interface Metrics {
  likes?: number;
  stocks?: number;
  stars?: number;
  points?: number;
  comments?: number;
  hatena?: number;
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
  /** 重複排除でまとめた際に、どのソースから見つかったか。話題性の判定に使う */
  foundIn?: SourceKind[];
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
 * キュレーションのレーン。読者が持つ 3 つの目的にそのまま対応する。
 *
 * ひとつの「価値スコア」に畳むと、いちばん測りやすい指標——このツールでは
 * 関心トピックとのキーワード一致——だけが残る。実測で掲載記事の 43% が
 * 単一プロダクトの話に偏ったのはそれが原因だった。目的ごとに別の証拠を使い、
 * 別の予算を与える。
 *
 * - know : 知る。規模の大きい話。影響範囲 × 取り返しのつかなさで測る。
 *          読者の関心と独立に成立するので、トピック一致を判定に使わない。
 * - build: 作る。試したくなるもの。可能性の差分 × 触れる実体で測る。
 *          新しいものほど語彙に無いので、ここでも一致は主軸にしない。
 *          どのレーンにも寄らなかったものはここに入る（既定のレーン）。
 * - talk : 話す。意見が言えるもの。立場が割れることを discussion 量と語彙で測る。
 *          二次情報のほうが強いことが多いので、一次情報を優遇しない。
 */
export const LANES = ['know', 'build', 'talk'] as const;
export type Lane = (typeof LANES)[number];

/** 実行ログ・LLM への指示・画面で共通の表示名 */
export const LANE_LABELS: Record<Lane, string> = {
  know: '知る',
  build: '作る',
  talk: '話す',
};

/**
 * talk レーンの記事に付ける「意見の足場」。
 *
 * 意見が出ない理由を分解すると、主張の理解 → 反対側の把握 → 自分の位置決め →
 * 自分にしか書けない一点、の順にハードルが上がる。詰まるのは最後の一点なので、
 * そこを名指しする。意見の下書きは作らない——そのまま出せてしまうと読者の
 * 言葉でなくなるうえ、裏取りされていない文章が外に出る。渡すのは足場だけ。
 */
export interface Debate {
  /** 争点。「A か B か」の形にする */
  axis: string;
  /** 賛成側の一番強い言い分 */
  forSide: string;
  /** 反対側の一番強い言い分 */
  againstSide: string;
  /**
   * 記事が片側しか書いていないか。true のとき againstSide は記事の外から
   * 補った一般的な反論なので、そのまま引用してはいけないことを画面で示す。
   */
  oneSided: boolean;
  /** 読者のプロフィール上、実体験として語れそうな接点 */
  yourAngle: string;
}

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
  /** talk レーンのときだけ入る意見の足場。他のレーンでは null */
  debate: Debate | null;
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
 * 深掘りカードの共通部分。
 *
 * 差分（何が変わるか / 何ができるようになるか）はレーンごとに 1 項目へ統合してある。
 * 3 レーンとも見ているのは同じ差分で、見る向きが違うだけ。
 *
 * - know : 自分への影響として見る → impact
 * - build: 可能性の広がりとして見る → unlocks（「これまで◯◯ → これから△△」の形）
 * - talk : そもそも差分ではなく立場の対立なので、どちらも持たない
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
  code: { lang: string; caption: string; content: string } | null;
  relatedLinks: { label: string; url: string }[];
  readingMinutes: number;
}

/** 知る: 読者が知りたいのは使い方ではなく「自分がどう巻き込まれるか」 */
export interface KnowDeepDive extends DeepDiveBase {
  lane: 'know';
  /** 誰の・どの構成に効くか。1 行ずつ・条件だけ */
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
   * できるようになること。「これまで◯◯ → これから△△」の差分形で、
   * **いちばん重要なものだけ**。付随機能を並べると、何が新しいのか分からなくなる。
   */
  unlocks: string[];
  howToTry: string[];
  /**
   * 「自分に効くか」を読者が YES / NO で答えられる条件（画面では「効く条件」）。
   *
   * 以前は「向いている場面」で、人物像（「効率化したい開発者」）が返ってきていた。
   * それは誰にでも当てはまるので判定に使えない。観測できる状態で書かせる。
   */
  fitFor: string[];
  /** 当てはまったら読まなくてよい条件（画面では「効かない条件」） */
  notFor: string[];
  /** 知らないと詰まる・金がかかる・壊れる、のどれかに当たるものだけ */
  caveats: string[];
}

/**
 * 争点を論点ごとに分解した対。
 *
 * 以前は賛成側の根拠と反対側の根拠を別々の平行なリストで持っていた。読者が頭の中で
 * 対応づけないと噛み合いが見えず、実測では対応していない項目も混ざっていた
 * （記事と同じ立場の補強が「反対側の根拠」に入っていた）。議論の形は
 * 「A と言われるが B だ」という噛み合いなので、対で持つ。
 */
export interface Clash {
  /** 何について争っているか。名詞句 */
  point: string;
  /** こう言われる（記事の立場） */
  claim: string;
  /** こう返せる（反対の立場）。claim と必ず噛み合っていること */
  counter: string;
  /**
   * その反論が記事の中にあるか。false のとき counter は記事の外から補ったものなので、
   * 記事の主張として引用してはいけないことを画面で示す。
   */
  counterInArticle: boolean;
}

/**
 * 読者が自分の経験からこの争点に足せること（画面では「一次情報を出すとしたら？」）。
 *
 * 発信の最大の障壁は「これを自分が言っていいのか」なので、切り口の名前だけでは足りない。
 * **なぜこの読者がそれを言えるのか**を対で持たせる。
 */
export interface Firsthand {
  /** 書ける切り口の名前。**名詞句だけ**。文にすると意見の代筆になる */
  angle: string;
  /** なぜこの読者がそれを言えるのか。読者プロフィールとの接点 */
  why: string;
}

/**
 * 話す: 発信するための材料を渡す。意見の下書きは作らない。
 *
 * このレーンの行動変容は「発信したくなること」で、カードの中心の問いは
 * **「この争点に、自分の経験から何を足せるか」**。両側の言い分が分かっても人は発信しない
 * （それで得られるのは「詳しくなった」状態）。発信が起きるのは、自分の手元にある事実が
 * この議論の材料になると気づいた瞬間なので、そこを名指しする。
 */
export interface TalkDeepDive extends DeepDiveBase {
  lane: 'talk';
  /** 論点ごとの噛み合い（画面では「争点」） */
  clashes: Clash[];
  /** 読者が足せること（画面では「一次情報を出すとしたら？」） */
  firsthand: Firsthand[];
  /** 自分の環境で主張の真偽を確かめる方法（画面では「確かめられること」）。無ければ空 */
  verify: string[];
}

export type DeepDive = KnowDeepDive | BuildDeepDive | TalkDeepDive;

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
   * TalkDeepDive.angles と同じ思想・同じ後処理を通す。
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
  feeds: { label: string; url: string; weight: number }[];
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
