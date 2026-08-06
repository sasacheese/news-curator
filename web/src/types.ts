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
  reason: string;
  keywords: string[];
  category: string;
  /** AI が主題か、それ以外か */
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
    };

export interface DeepDive {
  headline: string;
  summary: string;
  prerequisites?: Prerequisite[];
  visual?: Visual | null;
  whatYouCanDo: string[];
  whatChanges: string[];
  howToTry: string[];
  code: { lang: string; caption: string; content: string } | null;
  whyItMatters: string;
  caveats: string[];
  relatedLinks: { label: string; url: string }[];
  readingMinutes: number;
}

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

export interface Digest {
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  /** 冒頭の3〜5行の案内文。この機能より前の日は undefined */
  summary?: string[];
  top: TopItem[];
  releases?: ReleaseItem[];
  others: RankedItem[];
  stats: {
    collected: number;
    afterDedupe: number;
    afterPreScore: number;
    ranked: number;
    bySource: Record<string, number>;
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
