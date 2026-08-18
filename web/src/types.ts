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

export type Payoff = 'apply' | 'decide' | 'aware';

/** この情報がどれくらい保つか */
export type Durability = 'foundational' | 'durable' | 'ephemeral';

/**
 * キュレーションのレーン。読者の 3 つの目的に対応する。
 * この機能より前の日は undefined で、代わりに domain（ai / general）が入っている。
 */
export type Lane = 'know' | 'build' | 'talk';

/** talk レーンの記事に付く「意見の足場」。意見の下書きではない */
export interface Debate {
  axis: string;
  forSide: string;
  againstSide: string;
  /** 記事が片側しか書いていないか。true なら againstSide は記事の外からの補い */
  oneSided?: boolean;
  yourAngle?: string;
}

export interface RankedItem {
  id: string;
  source: SourceKind;
  sourceLabel: string;
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  authorDetail?: AuthorDetail;
  tags: string[];
  snippet: string;
  metrics: Metrics;
  lang: string;
  matchedTopics: string[];
  score: number;
  oneLiner: string;
  /**
   * 「3行で要約」。専門用語を使わずに書いた 3 行。
   * この機能より前の日は undefined で、代わりに reason（1 本の文）が入っている。
   */
  takeaways?: string[];
  /** 旧「読みどころ」。takeaways 導入より前の日にだけ入っている */
  reason?: string;
  keywords: string[];
  category: string;
  /** どの目的で選ばれたか。この機能より前の日は undefined */
  lane?: Lane;
  /** talk レーンの記事に付く意見の足場 */
  debate?: Debate | null;
  /** 旧: AI が主題か、それ以外か。レーン導入前の日にだけ入っている */
  domain?: 'ai' | 'general';
  /** 元記事の読了目安（分） */
  readingMinutes?: number;
  /** 読んだ結果として何が得られるか */
  payoff?: Payoff;
  /** この情報がどれくらい保つか。この機能より前の日は undefined */
  durability?: Durability;
  /** 他のエンジニアと共通の話題になりうるか。この機能より前の日は undefined */
  buzz?: boolean;
}

export interface Prerequisite {
  term: string;
  /** 記事のどこで詰まるか */
  stumblingPoint?: string;
  explanation: string;
}

export interface UsageStat {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

export interface UsageReport {
  stages: Record<string, UsageStat>;
  totalCostUsd: number;
}

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

export interface DeepDiveBase {
  /** 記事の語彙をそのまま使った詳しい要約。平易な側は takeaways が引き受ける */
  summary: string;
  prerequisites?: Prerequisite[];
  visual?: Visual | null;
  code: { lang: string; caption: string; content: string } | null;
  /**
   * 「なぜ重要か」。いまは talk レーン（なぜ今この争点か）と
   * レーン導入前の日だけが持つ。know / build では summary と重複していたので落とした。
   */
  whyItMatters?: string;
  relatedLinks: { label: string; url: string }[];
  readingMinutes: number;
  /** 旧: サイト側で付けていた見出し。廃止したので過去日にだけ入っている */
  headline?: string;
}

export interface KnowDeepDive extends DeepDiveBase {
  lane: 'know';
  impact: string[];
  timeline: string[];
  checkNow: string[];
  unknowns: string[];
}

export interface BuildDeepDive extends DeepDiveBase {
  lane: 'build';
  unlocks: string[];
  howToTry: string[];
  fitFor: string[];
  notFor: string[];
  caveats: string[];
}

/** 争点を論点ごとに分解した対。「A と言われるが B だ」の噛み合いを表す */
export interface Clash {
  point: string;
  /** こう言われる（記事の立場） */
  claim: string;
  /** こう返せる（反対の立場） */
  counter: string;
  /** false なら counter は記事の外から補ったもの。記事の主張として引用させない */
  counterInArticle?: boolean;
}

/** 読者が足せること。切り口と「なぜ自分が言えるか」の対 */
export interface Firsthand {
  /** 切り口の名前。名詞句のみ */
  angle: string;
  /** なぜこの読者がそれを言えるのか */
  why: string;
}

export interface TalkDeepDive extends DeepDiveBase {
  lane: 'talk';
  /** 論点ごとの噛み合い（画面では「争点」）。この形より前の日は undefined */
  clashes?: Clash[];
  /** 読者が足せること（画面では「一次情報を出すとしたら？」） */
  firsthand?: Firsthand[];
  verify: string[];
  /* 以下は clashes / firsthand 導入より前の日にだけ入っている */
  /** 旧: 賛成側の根拠 */
  evidence?: string[];
  /** 旧: 反対側の根拠 */
  counterEvidence?: string[];
  /** 旧: 成り立つ条件・崩れる条件 */
  whenItHolds?: string[];
  /** 旧: 語れる角度（名詞句のみ、根拠なし） */
  angles?: string[];
}

/**
 * レーン導入前に生成した日のカード。
 *
 * 過去のダイジェストは data/ にそのまま残っていて、日付を遡ると今でも表示される。
 * 「何ができるようになるか」と「何が変わるか」を別項目で持っていた頃の形。
 */
export interface LegacyDeepDive extends DeepDiveBase {
  lane?: undefined;
  whatYouCanDo: string[];
  whatChanges: string[];
  howToTry: string[];
  caveats: string[];
}

export type DeepDive = KnowDeepDive | BuildDeepDive | TalkDeepDive | LegacyDeepDive;

export interface TopItem extends RankedItem {
  rank: number;
  deep: DeepDive;
}

export type ReleaseKind = 'ai-model' | 'major' | 'minor' | 'patch' | 'service';

/** そのリリースで読者に何が起きるか。並べ替えと折りたたみはこの軸で行う */
export type ReleaseImpact = 'unlocks' | 'security' | 'improves' | 'chore';

/** 脆弱性の情報。GitHub Security Advisories 由来のときだけ入る */
export interface ReleaseAdvisory {
  cveId: string | null;
  ghsaId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  cvss: number | null;
  packageName: string;
  patchedVersion: string | null;
}

/** 代表にまとめた同じ製品の他の項目 */
export interface ReleaseAlso {
  label: string;
  url: string;
}

export interface ReleaseItem {
  id: string;
  product: string;
  what?: string | null;
  version: string | null;
  kind: ReleaseKind;
  /** この機能より前に生成した日は undefined。その場合は kind から寄せる */
  impact?: ReleaseImpact;
  /** 「〜できるようになる」の1文。無ければ null */
  unlock?: string | null;
  /** 変化の大きさを差分で見せる */
  change?: { before: string; after: string } | null;
  /** 新たに対応した環境 */
  scope?: string[];
  advisory?: ReleaseAdvisory;
  summary: string;
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt: string;
  /** この機能より前に生成した日は文字列配列なので、両方を受ける */
  alsoReleased: (string | ReleaseAlso)[];
}

/**
 * テックコミュニティの情報（イベント・登壇募集・もくもく会）。
 *
 * 記事ともリリースとも軸が違う。開催日と締切（未来）が本体なので順位を付けず、
 * 日付で並べる。開催まで毎日出るのが正しいので、記事のように重複排除で落とさない。
 * 代わりに前回との差を isNew で見せる。
 *
 * 日次ダイジェストには入らない。data/community.json に 1 ファイルで持ち、
 * 専用タブに出す（流動性が高く、その日の記録として残す意味が無いため）。
 */
export type CommunityAction = 'speak' | 'attend' | 'work';
export type CommunityScale = 'conference' | 'meetup' | 'recurring';

export interface CommunityDeadline {
  kind: 'cfp' | 'apply';
  at: string;
  /** 生成日を基準にした残り日数。過去日を開いたときに負の値を出さないため保存値を使う */
  daysLeft: number;
}

export interface CommunityItem {
  id: string;
  action: CommunityAction;
  title: string;
  url: string;
  organizer: string | null;
  startsAt: string;
  endsAt: string | null;
  venue: {
    mode: 'online' | 'onsite' | 'hybrid';
    place: string | null;
    prefecture: string | null;
    country: string;
  };
  deadline: CommunityDeadline | null;
  scale: CommunityScale;
  capacity: { limit: number | null; accepted: number | null; waiting: number | null } | null;
  what: string;
  /** speak のときだけ。読み取れなければ null */
  callFor: string | null;
  /** speak のときだけ。名詞句だけが入る */
  angles: string[];
  isNew: boolean;
  sourceLabel: string;
  matchedTopics: string[];
}

/** data/community.json。履歴を持たず、毎回まるごと差し替わる */
export interface CommunityBoard {
  updatedAt: string;
  /** 生成日（JST）。deadline.daysLeft と「今日」の基準日 */
  date: string;
  items: CommunityItem[];
  byAction?: Record<string, number>;
  notes?: string[];
}

export interface Digest {
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  /** 冒頭の3〜5行の案内文。この機能より前の日は undefined */
  summary?: string[];
  /** サマリー末尾に置く「この先の見立て」。この機能より前の日と、生成できなかった日は無い */
  outlook?: string | null;
  top: TopItem[];
  releases?: ReleaseItem[];
  others: RankedItem[];
  stats: {
    collected: number;
    afterDedupe: number;
    afterPreScore: number;
    ranked: number;
    bySource: Record<string, number>;
    /** レーンごとの掲載件数。レーン導入前の日は undefined */
    byLane?: Record<string, number>;
    estimatedReadMinutes: number;
  };
  topics: string[];
  models: { rank: string; summary: string };
  usage?: UsageReport;
  notes: string[];
}

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
  score: number;
  publishedAt: string;
  lang: string;
}

export interface Manifest {
  /** 初回生成前は null */
  updatedAt: string | null;
  latest: string | null;
  dates: string[];
  months: string[];
  /** 生成元リポジトリ（owner/repo）。設定ファイルの編集画面へのリンクに使う */
  repo?: string | null;
}

/** リリース情報の監視対象。config/watchlist.json をそのまま読む */
export interface Watchlist {
  repos: string[];
  feeds: { label: string; url: string; weight?: number }[];
  changelogs: { label: string; url: string; homepage?: string }[];
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
