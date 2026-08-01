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
}

export interface PreScoredItem extends RawItem {
  preScore: number;
  /** その日・そのソース内での人気の順位（0〜1）。指標を持たないソースは 0.5 */
  popularityPercentile: number;
  matchedTopics: string[];
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
  reason: string;
  keywords: string[];
  category: string;
  /** AI が主題か、それ以外か */
  domain: 'ai' | 'general';
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
    };

export interface DeepDive {
  headline: string;
  summary: string;
  prerequisites: Prerequisite[];
  visual: Visual | null;
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

/**
 * リリース情報。
 *
 * 「知っているか知らないか」だけで差が出る種類の情報なので、
 * ランキングせずに全件出す。ベスト3とは別枠。
 */
export const RELEASE_KINDS = ['ai-model', 'major', 'minor', 'patch', 'service'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

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

export interface ReleaseItem {
  id: string;
  /** 製品・ライブラリ名 */
  product: string;
  /** その製品が何をするものか。1文。判別できなければ null */
  what: string | null;
  version: string | null;
  kind: ReleaseKind;
  /** 何が入ったか。1〜2文 */
  summary: string;
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt: string;
  /** 代表にまとめた同じ製品の他の項目 */
  alsoReleased: ReleaseAlso[];
}

export interface Digest {
  date: string;
  generatedAt: string;
  window: { start: string; end: string };
  top: TopItem[];
  releases: ReleaseItem[];
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
