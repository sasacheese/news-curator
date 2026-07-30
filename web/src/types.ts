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

export interface RankedItem {
  id: string;
  source: SourceKind;
  sourceLabel: string;
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
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
}

export interface DeepDive {
  headline: string;
  summary: string;
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

export interface Digest {
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  top: TopItem[];
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
