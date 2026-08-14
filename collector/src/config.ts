import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdvisoryConfig } from './advisories.js';
import type { CommunityConfig } from './community.js';
import type { TopicsConfig, Watchlist } from './types.js';
import { log } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
export const CONFIG_DIR = resolve(REPO_ROOT, 'config');
export const DATA_DIR = resolve(REPO_ROOT, 'data');

export interface SourcesConfig {
  qiita: { enabled: boolean; maxPages: number; perPage: number };
  zenn: { enabled: boolean; orders: string[]; count: number };
  hatena: { enabled: boolean; feeds: string[] };
  hackernews: {
    enabled: boolean;
    minPoints: number;
    /** Show HN 用の低いしきい値。誰も知らない個人の新作は普通の網では落ちる */
    showHnMinPoints: number;
    hitsPerPage: number;
  };
  devto: { enabled: boolean; perPage: number; minReactions: number };
  githubReleases: { enabled: boolean; repos: string[]; includePrerelease: boolean };
  githubTrending: { enabled: boolean; minStars: number; perPage: number; queries: string[] };
  /** 検索語を持たない新着枠。「まだ名前を知らない道具」はここからしか入ってこない */
  githubNew: { enabled: boolean; minStars: number; days: number; perPage: number };
  rss: { enabled: boolean; feeds: { label: string; url: string; weight: number }[] };
  changelogs: { enabled: boolean; entries: { label: string; url: string; homepage: string }[] };
  advisories: AdvisoryConfig;
}

/** sources.json の「監視対象リスト抜き」の形。リストは watchlist.json から合流させる。 */
type SourcesFile = Omit<
  SourcesConfig,
  'githubReleases' | 'rss' | 'changelogs' | 'advisories' | 'githubNew' | 'hackernews'
> & {
  /* この機能より前の sources.json には無いので任意にする */
  githubNew?: Partial<SourcesConfig['githubNew']>;
  hackernews: Omit<SourcesConfig['hackernews'], 'showHnMinPoints'> &
    Partial<Pick<SourcesConfig['hackernews'], 'showHnMinPoints'>>;
  githubReleases: Omit<SourcesConfig['githubReleases'], 'repos'>;
  rss: Omit<SourcesConfig['rss'], 'feeds'>;
  changelogs: Omit<SourcesConfig['changelogs'], 'entries'>;
  /** この機能より前に書かれた sources.json には無いので任意にする */
  advisories?: Partial<SourcesConfig['advisories']>;
};

/** 実行時のチューニング項目。すべて環境変数で上書きできる。 */
export interface RuntimeConfig {
  /** 1 レーンあたり LLM へ渡す候補数。合計はこの 3 倍 */
  laneCandidates: number;
  /** レーンの振り分けしきい値。実データを見ながら動かす前提 */
  laneThresholds: { know: number; talk: number };
  /** 深掘り要約する件数（= 各レーンのベスト N） */
  topN: number;
  /** 「その他の注目記事」として保存する件数 */
  otherN: number;
  /** 深掘りする最低スコア。これを下回るレーンは件数を減らす */
  minTopScore: number;
  /** 一覧に載せる最低スコア */
  minOtherScore: number;
  rankModel: string;
  summaryModel: string;
  summaryEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 深掘り時に LLM へ渡す本文の最大文字数 */
  bodyCharLimit: number;
  /** ランキング 1 リクエストあたりのアイテム数 */
  rankBatchSize: number;
  cutoffHour: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const effort = str('SUMMARY_EFFORT', 'medium') as RuntimeConfig['summaryEffort'];
  return {
    /**
     * 1 レーンあたり LLM に採点させる候補数。合計 150 件は 3 レーン化の前と同じ。
     *
     * 採点は 2 段階（スコアのみ → 上位だけ文章化）なので、ここを増やして
     * 増えるのは安い 1 段目の入力だけ。2 段目と深掘りのコストは変わらない。
     *
     * 逆に絞る方向は割に合わない。以前 45 まで下げる案を実データで検証したとき、
     * 46〜60 位の帯に「実際にベスト入りした記事」が含まれていた。
     */
    laneCandidates: num('LANE_CANDIDATES', 50),
    /**
     * レーンの振り分けしきい値。
     *
     * know / talk は「要件を満たすか」で判定し、満たさなければ build に落ちる
     * （build が既定のレーン）。適正値は実データを見ないと決められないので、
     * 実行ログにレーン別の件数を出して調整する前提の値にしてある。
     *
     * 高くしすぎると know / talk が空になり、低くしすぎると build から
     * 中身の薄いものが流れ込む。まずはログの「振り分け」の行を見て、
     * know が 1 日 30〜80 件、talk が 40〜100 件くらいに収まるあたりを狙う。
     */
    laneThresholds: {
      know: num('KNOW_THRESHOLD', 0.42),
      talk: num('TALK_THRESHOLD', 0.4),
    },
    /**
     * 深掘りする件数。**レーンごと**なので、既定 2 で 6 件。
     * 深掘りは Sonnet を使う一番高い工程で、実測でも全体の 6〜7 割を占める。
     * 2 レーン時代の 4 件から 6 件になるので、1 日あたり $0.06〜0.08 ほど増える。
     * コストを戻したいなら TOP_N=1（3 件）にする。
     */
    topN: num('TOP_N', 2),
    /** 「その他の注目記事」の合計。3 レーンで等分する（既定 12 → 各 4 件） */
    otherN: num('OTHER_N', 12),
    /**
     * 掲載のスコア下限。
     *
     * レーンを分けたことで「そのレーンに該当が乏しい日」が起きうるようになった。
     * 下限が無いと、候補の質に関係なく必ず topN 件が深掘りされる——採点が
     * 全部 20 点の日でも、その中の上位 2 件が Sonnet に回ってベストとして出る。
     * 件数を埋めることより、薄い日は薄いまま出すことを優先する。
     *
     * 採点基準では 40 点以下が「目的に沿わない」の帯なので、深掘りはその少し上、
     * 一覧はその手前に置いている。
     */
    minTopScore: num('MIN_TOP_SCORE', 45),
    minOtherScore: num('MIN_OTHER_SCORE', 30),
    rankModel: str('RANK_MODEL', 'claude-haiku-4-5'),
    summaryModel: str('SUMMARY_MODEL', 'claude-sonnet-5'),
    summaryEffort: (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(effort)
      ? effort
      : 'medium',
    bodyCharLimit: num('BODY_CHAR_LIMIT', 12_000),
    rankBatchSize: num('RANK_BATCH_SIZE', 18),
    cutoffHour: num('CUTOFF_HOUR', 7),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadTopics(): Promise<TopicsConfig> {
  const raw = await readJson<TopicsConfig & { $comment?: string }>(
    resolve(CONFIG_DIR, 'topics.json'),
  );
  return {
    profile: raw.profile ?? '',
    topics: (raw.topics ?? []).filter((t) => t?.name).map((t) => ({
      name: t.name,
      weight: Number.isFinite(t.weight) ? t.weight : 3,
      keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
    })),
    exclude: { keywords: (raw.exclude?.keywords ?? []).map((k) => k.toLowerCase()) },
  };
}

/**
 * 監視対象リストを読む。
 *
 * このファイルは GitHub の Web エディタから手で編集される前提なので、
 * 書式を外した項目は落として警告するだけにとどめる。1 行の typo で
 * その日の収集が丸ごと止まる方が損失が大きい。
 */
export async function loadWatchlist(): Promise<Watchlist> {
  const raw = await readJson<Partial<Watchlist>>(resolve(CONFIG_DIR, 'watchlist.json'));
  const dropped: string[] = [];

  const repos = uniqueBy(
    asArray(raw.repos).filter((r) => {
      const ok = typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.trim());
      if (!ok) dropped.push(`repos: ${JSON.stringify(r)}`);
      return ok;
    }).map((r) => r.trim()),
    (r) => r.toLowerCase(),
  );

  const feeds = uniqueBy(
    asArray(raw.feeds).flatMap((f) => {
      if (!f || typeof f !== 'object' || !isHttpUrl(f.url) || !f.label?.trim()) {
        dropped.push(`feeds: ${JSON.stringify(f)}`);
        return [];
      }
      const weight = Number(f.weight);
      return [
        {
          label: f.label.trim(),
          url: f.url.trim(),
          weight: Number.isFinite(weight) ? clamp(weight, 1, 5) : 3,
        },
      ];
    }),
    (f) => normalizeKey(f.url),
  );

  const changelogs = uniqueBy(
    asArray(raw.changelogs).flatMap((c) => {
      if (!c || typeof c !== 'object' || !isHttpUrl(c.url) || !c.label?.trim()) {
        dropped.push(`changelogs: ${JSON.stringify(c)}`);
        return [];
      }
      return [
        {
          label: c.label.trim(),
          url: c.url.trim(),
          homepage: isHttpUrl(c.homepage) ? c.homepage.trim() : c.url.trim(),
        },
      ];
    }),
    (c) => normalizeKey(c.url),
  );

  if (dropped.length > 0) {
    log.warn(
      `watchlist.json の ${dropped.length} 件を書式不正としてスキップしました: ${dropped.join(', ')}`,
    );
  }
  log.info(
    `監視対象: リポジトリ ${repos.length} / フィード ${feeds.length} / CHANGELOG ${changelogs.length}`,
  );
  return { repos, feeds, changelogs };
}

/** community.json の既定値。ファイルが無い / 項目が欠けているときに埋める */
const COMMUNITY_DEFAULTS: CommunityConfig = {
  enabled: false,
  location: { prefectures: ['東京都'], online: true },
  horizonDays: 21,
  cfpHorizonDays: 45,
  keywords: [],
  exclude: [],
  excludeOrganizers: [],
  cfpTopics: [],
  limits: { speak: 6, attend: 8, work: 4 },
};

/**
 * コミュニティ情報の設定を読む。
 *
 * watchlist.json と同じく Web エディタから手で編集される前提なので、
 * 欠けている項目は既定値で埋めて先に進む。ファイルが無い場合は
 * 機能ごと無効にする（この機能より前のチェックアウトで落ちないようにするため）。
 */
export async function loadCommunity(): Promise<CommunityConfig> {
  let raw: Partial<CommunityConfig>;
  try {
    raw = await readJson<Partial<CommunityConfig>>(resolve(CONFIG_DIR, 'community.json'));
  } catch {
    log.warn('config/community.json が読めないため、コミュニティ情報を無効にします。');
    return COMMUNITY_DEFAULTS;
  }

  const strings = (v: unknown): string[] =>
    asArray(v as string[] | undefined)
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());

  return {
    enabled: raw.enabled !== false,
    location: {
      prefectures: strings(raw.location?.prefectures),
      online: raw.location?.online !== false,
    },
    horizonDays: clamp(Number(raw.horizonDays) || COMMUNITY_DEFAULTS.horizonDays, 1, 120),
    cfpHorizonDays: clamp(
      Number(raw.cfpHorizonDays) || COMMUNITY_DEFAULTS.cfpHorizonDays,
      1,
      365,
    ),
    keywords: strings(raw.keywords),
    exclude: strings(raw.exclude),
    excludeOrganizers: strings(raw.excludeOrganizers),
    cfpTopics: strings(raw.cfpTopics),
    limits: {
      speak: clamp(Number(raw.limits?.speak) || COMMUNITY_DEFAULTS.limits.speak, 0, 30),
      attend: clamp(Number(raw.limits?.attend) || COMMUNITY_DEFAULTS.limits.attend, 0, 30),
      work: clamp(Number(raw.limits?.work) || COMMUNITY_DEFAULTS.limits.work, 0, 30),
    },
  };
}

export async function loadSources(): Promise<SourcesConfig> {
  const [file, watchlist] = await Promise.all([
    readJson<SourcesFile>(resolve(CONFIG_DIR, 'sources.json')),
    loadWatchlist(),
  ]);
  return {
    ...file,
    hackernews: { ...file.hackernews, showHnMinPoints: file.hackernews.showHnMinPoints ?? 5 },
    githubNew: {
      enabled: file.githubNew?.enabled ?? true,
      minStars: file.githubNew?.minStars ?? 80,
      days: clamp(file.githubNew?.days ?? 10, 1, 60),
      perPage: clamp(file.githubNew?.perPage ?? 40, 1, 100),
    },
    githubReleases: { ...file.githubReleases, repos: watchlist.repos },
    rss: { ...file.rss, feeds: watchlist.feeds },
    changelogs: { ...file.changelogs, entries: watchlist.changelogs },
    // この機能より前の sources.json には advisories が無いので既定値で埋める
    advisories: {
      enabled: file.advisories?.enabled ?? false,
      severities: asArray(file.advisories?.severities).filter((v) => typeof v === 'string'),
      ecosystems: asArray(file.advisories?.ecosystems).filter((v) => typeof v === 'string'),
      extraPackages: asArray(file.advisories?.extraPackages).filter((v) => typeof v === 'string'),
      perPage: clamp(file.advisories?.perPage ?? 100, 1, 100),
    },
  };
}

function asArray<T>(v: T[] | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 末尾スラッシュだけ違う重複を拾うための正規化 */
function normalizeKey(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
