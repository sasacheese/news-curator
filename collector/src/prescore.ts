import type { Lane, PreScoredItem, RawItem, SourceKind, TopicsConfig } from './types.js';
import { GENERAL_LANES, LANES } from './types.js';
import { isHttpUrl, normalizeUrl, titleKey } from './util.js';

/**
 * そのソースにおける主要な人気指標の生値。
 *
 * Qiita の LGTM・HN の points・GitHub の star は単位も桁も違うので、
 * この生値どうしを直接比べてはいけない（→ popularityPercentiles で正規化する）。
 */
function rawPopularity(item: RawItem): number | null {
  const m = item.metrics;
  switch (item.source) {
    case 'qiita':
    case 'zenn':
    case 'devto':
      return (m.likes ?? 0) + (m.stocks ?? 0) * 0.5;
    case 'hackernews':
      return m.points ?? 0;
    case 'hatena':
      return m.hatena ?? 0;
    case 'github_repo':
      return m.stars ?? 0;
    case 'x': {
      // いいね + リポスト等を、公開からの時間で割って順位にする（割るのは呼び出し側）。
      // 表示回数は桁が違いすぎるので入れない。指標が一つも無ければ「測れない」。
      const has =
        m.likes != null ||
        m.reposts != null ||
        m.quotes != null ||
        m.replies != null ||
        m.bookmarks != null;
      if (!has) return null;
      return (
        (m.likes ?? 0) +
        (m.reposts ?? 0) * 2 +
        (m.quotes ?? 0) * 2 +
        (m.replies ?? 0) * 0.5 +
        (m.bookmarks ?? 0)
      );
    }
    default:
      // RSS・リリースノート・CHANGELOG は人気指標を持たない
      return m.hatena ?? null;
  }
}

/** 公開からの経過時間（時間単位）。速さの比較に使う。 */
function hoursSince(item: RawItem, now: Date): number {
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return 24;
  return Math.max(1, (now.getTime() - published) / 3_600_000);
}

/**
 * 人気度を「その日・そのソース内での順位」に正規化する。
 *
 * プラットフォームをまたいで生の数字を比べることはできないが、
 * 「Qiita の today 上位5%」と「HN の today 上位5%」なら比較できる。
 * 固定の対数スケールと違って母集団に自動で追従するので、
 * 閑散日に低い値ばかりになったり、祭りの日に全部飽和したりしない。
 *
 * さらに、生値そのものではなく「1時間あたりの伸び」で順位をつける。
 * 3時間で20 LGTM の記事は、20時間で30 LGTM の記事より勢いがある。
 */
export function popularityPercentiles(items: RawItem[], now = new Date()): Map<string, number> {
  const bySource = new Map<SourceKind, { id: string; rate: number }[]>();

  for (const item of items) {
    const raw = rawPopularity(item);
    if (raw == null) continue;
    const list = bySource.get(item.source) ?? [];
    list.push({ id: item.id, rate: raw / hoursSince(item, now) });
    bySource.set(item.source, list);
  }

  const percentiles = new Map<string, number>();
  for (const list of bySource.values()) {
    // 母集団が小さすぎると順位に意味が無いので、中庸に倒す
    if (list.length < 5) {
      for (const entry of list) percentiles.set(entry.id, 0.5);
      continue;
    }
    list.sort((a, b) => a.rate - b.rate);
    const last = list.length - 1;
    for (let i = 0; i < list.length; i++) {
      percentiles.set(list[i]!.id, i / last);
    }
  }

  return percentiles;
}

/**
 * タイトル・タグ・本文へのトピックキーワードのマッチ度。
 *
 * 本文へのマッチはスコアには効かせるが `matched` には含めない。
 * 長いリリースノートには "agent" や "顧客" のような語がたまたま含まれるため、
 * 本文ヒットまで拾うと無関係なトピック名が記事に付いてしまう。
 */
function topicMatch(item: RawItem, topics: TopicsConfig['topics']) {
  const title = item.title.toLowerCase();
  const tags = item.tags.join(' ').toLowerCase();
  const body = `${item.snippet} ${item.body ?? ''}`.toLowerCase().slice(0, 4000);

  let score = 0;
  const matched: string[] = [];

  for (const topic of topics) {
    let hit = 0;
    for (const kw of topic.keywords) {
      if (!kw) continue;
      if (title.includes(kw)) hit = Math.max(hit, 3);
      else if (tags.includes(kw)) hit = Math.max(hit, 2);
      else if (body.includes(kw)) hit = Math.max(hit, 1);
    }
    if (hit >= 2) matched.push(topic.name);
    if (hit > 0) score += hit * topic.weight;
  }

  // 5 トピック以上に薄く当たっているだけの記事は過大評価しない
  const normalized = Math.min(1, score / 24);
  return { score: normalized, matched };
}

function excluded(item: RawItem, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const hay = `${item.title} ${item.tags.join(' ')}`.toLowerCase();
  return keywords.some((k) => k && hay.includes(k));
}

/** 一次情報（公式ブログ・リリースノート）は素点を上げる */
function sourceBonus(item: RawItem): number {
  switch (item.source) {
    case 'github_release':
    case 'changelog':
      return 0.28;
    case 'rss':
      return 0.06 + Math.min(0.18, item.sourceWeight * 0.035);
    case 'github_repo':
      return 0.05;
    case 'x':
      // 人が選んで置いた投稿なので、指標の無い一次情報の底上げよりは小さく、
      // 何も足さないコミュニティ投稿よりは残す。公式ブログ（rss）の基礎点と同じ。
      return 0.06;
    default:
      return 0;
  }
}


/**
 * 他のエンジニアと共通の話題になりうるか。
 *
 * 実測（590 件・24 時間）にもとづく絶対値のしきい値。相対順位は使わない——
 * その日の Qiita の中央値は LGTM 0 なので、相対では「LGTM 1」が上位 87% に来てしまう。
 *
 *   qiita   中央 0  上位1% 8    zenn        中央 1     上位10% 12
 *   HN      中央116 上位10% 492  github_repo 中央 1045  上位10% 3071
 */
export function isBuzzing(item: RawItem): boolean {
  const m = item.metrics;
  const from = item.foundIn ?? [item.source];

  // はてブのテクノロジーホットエントリーは、載った時点で定義上「話題」
  if (from.includes('hatena')) return true;
  // 他ソース由来でも、はてブが付き始めていれば拾う
  if ((m.hatena ?? 0) >= 5) return true;

  switch (item.source) {
    case 'qiita':
    case 'zenn':
    case 'devto':
      return (m.likes ?? 0) + (m.stocks ?? 0) * 0.5 >= 10;
    case 'hackernews':
      return (m.points ?? 0) >= 300;
    case 'github_repo':
      return (m.stars ?? 0) >= 3000;
    case 'x':
      // 実測が貯まるまでの絶対値。180 いいね、または 60 リポスト、あるいはその合算。
      // ここを下げると「いいねが少し付いた投稿」が毎日話題扱いになり、buzz が意味を失う。
      return (m.likes ?? 0) + (m.reposts ?? 0) * 3 + (m.quotes ?? 0) * 2 >= 180;
    default:
      // 公式ブログ・リリースノートは指標を持たないので、はてブが付くかどうかだけ
      return false;
  }
}

export function preScore(items: RawItem[], topics: TopicsConfig, now = new Date()): PreScoredItem[] {
  const percentiles = popularityPercentiles(items, now);

  return items.map((item) => {
    const { score: topicScore, matched } = topicMatch(item, topics.topics);
    // 人気指標を持たないソース（公式ブログ・リリースノート）は中庸に置き、
    // 一次情報ボーナスのほうで拾う
    const pop = percentiles.get(item.id) ?? 0.5;
    const penalty = excluded(item, topics.exclude.keywords) ? 0.65 : 0;
    // トピック適合を主、人気度を従にする
    const raw = topicScore * 0.68 + pop * 0.22 + sourceBonus(item) - penalty;
    return {
      ...item,
      preScore: Math.max(0, Math.min(1, raw)),
      popularityPercentile: pop,
      matchedTopics: matched,
      buzz: isBuzzing(item),
    };
  });
}

/** ベスト3に必ず1枠は入れたい性質。満たせない日は黙って諦める */
export interface SlotRule<T> {
  label: string;
  match: (item: T) => boolean;
}

/**
 * 上位 n 件を選ぶ。
 *
 * まずスコア順に 1 ソース 1 件で埋める（同じ日に nodejs/node のリリースが 3 本出ても
 * ベスト3を独占させないため）。そのうえで、満たされていない枠ルールがあれば
 * 下位の枠と入れ替えて確保する。
 *
 * 入れ替えは下位からで、1 位は必ず残す。その日の最重要が枠確保で押し出されるのは
 * 本末転倒なため。ルールを満たす候補が無い日は、そのルールは諦めてスコア順のままにする。
 */
export function pickTopDiverse<T extends { id: string; sourceLabel: string; score: number }>(
  ranked: readonly T[],
  n: number,
  rules: readonly SlotRule<T>[] = [],
): T[] {
  const picked: T[] = [];
  const usedSources = new Set<string>();

  for (const item of ranked) {
    if (picked.length >= n) break;
    if (usedSources.has(item.sourceLabel)) continue;
    picked.push(item);
    usedSources.add(item.sourceLabel);
  }

  if (picked.length < n) {
    const pickedIds = new Set(picked.map((i) => i.id));
    for (const item of ranked) {
      if (picked.length >= n) break;
      if (pickedIds.has(item.id)) continue;
      picked.push(item);
      pickedIds.add(item.id);
    }
  }

  for (const rule of rules) {
    if (picked.some(rule.match)) continue;

    const pickedIds = new Set(picked.map((i) => i.id));
    const candidate = ranked.find(
      (i) => rule.match(i) && !pickedIds.has(i.id) && !usedSources.has(i.sourceLabel),
    );
    if (!candidate) continue;

    // 他のルールを単独で満たしている枠は動かさない（確保し直しになるため）
    const soleSatisfiers = new Set(
      rules.flatMap((other) => {
        const hits = picked.filter(other.match);
        return hits.length === 1 ? hits.map((h) => h.id) : [];
      }),
    );

    for (let i = picked.length - 1; i >= 1; i--) {
      const victim = picked[i]!;
      if (soleSatisfiers.has(victim.id)) continue;
      usedSources.delete(victim.sourceLabel);
      picked[i] = candidate;
      usedSources.add(candidate.sourceLabel);
      break;
    }
  }

  return picked.sort((a, b) => b.score - a.score);
}

function maxMetric(a?: number, b?: number): number | undefined {
  const n = Math.max(a ?? 0, b ?? 0);
  return n > 0 ? n : undefined;
}

function mergeLinks(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

/**
 * URL 正規化・タイトル近似・過去ダイジェスト済み URL の 3 段で重複を落とす。
 * 同一記事が複数ソースから来た場合はメトリクスをマージする。
 */
export function dedupe(items: RawItem[], seenUrls: ReadonlySet<string>): RawItem[] {
  const byUrl = new Map<string, RawItem>();

  for (const item of items) {
    const key = normalizeUrl(item.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...item, foundIn: [item.source] });
      continue;
    }
    // 情報量の多い方を残しつつ、メトリクスは足し合わせる
    const winner = (existing.body?.length ?? 0) >= (item.body?.length ?? 0) ? existing : item;
    const loser = winner === existing ? item : existing;
    byUrl.set(key, {
      ...winner,
      snippet: winner.snippet || loser.snippet,
      body: winner.body ?? loser.body,
      // 同じ記事でも、はてブ経由より Qiita 経由のほうが作者情報が濃い
      author: winner.author ?? loser.author,
      authorDetail: winner.authorDetail ?? loser.authorDetail,
      tags: [...new Set([...winner.tags, ...loser.tags])],
      sourceWeight: Math.max(winner.sourceWeight, loser.sourceWeight),
      // どこから見つかったかは全部覚えておく（はてブ経由かどうかが話題性の根拠になる）
      foundIn: [...new Set([...(existing.foundIn ?? [existing.source]), item.source])],
      metrics: {
        likes: maxMetric(winner.metrics.likes, loser.metrics.likes),
        stocks: maxMetric(winner.metrics.stocks, loser.metrics.stocks),
        stars: maxMetric(winner.metrics.stars, loser.metrics.stars),
        points: maxMetric(winner.metrics.points, loser.metrics.points),
        comments: maxMetric(winner.metrics.comments, loser.metrics.comments),
        hatena: maxMetric(winner.metrics.hatena, loser.metrics.hatena),
        reposts: maxMetric(winner.metrics.reposts, loser.metrics.reposts),
        replies: maxMetric(winner.metrics.replies, loser.metrics.replies),
        quotes: maxMetric(winner.metrics.quotes, loser.metrics.quotes),
        bookmarks: maxMetric(winner.metrics.bookmarks, loser.metrics.bookmarks),
        impressions: maxMetric(winner.metrics.impressions, loser.metrics.impressions),
      },
      linkedUrls: mergeLinks(winner.linkedUrls, loser.linkedUrls),
    });
  }

  const seenTitles = new Set<string>();
  const out: RawItem[] = [];
  for (const item of byUrl.values()) {
    // 外部 API / RSS 由来の link は信用しない（javascript: などを保存させない）
    if (!isHttpUrl(item.url)) continue;
    if (seenUrls.has(normalizeUrl(item.url))) continue;
    /*
     * 投稿には題が無いので、見出しは「作者 + 本文の1行目」から作っている。
     * 同じ書き出しの別投稿（スレッド、引用、定型の告知）まで記事の近似重複として
     * 落とすと、URL が違うのに片方が消える。投稿は URL だけで同一判定する。
     * タイトルキーにも入れない。先に処理した投稿が、後続の記事を巻き込まないため。
     */
    if (item.source !== 'x') {
      const tk = titleKey(item.title);
      if (tk.length >= 8) {
        if (seenTitles.has(tk)) continue;
        seenTitles.add(tk);
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * 一覧をレーンごとの予算で選ぶ。
 *
 * 目的が違うものを 1 本のスコア順で並べると、いちばん件数の多い目的が全部を取る。
 * 以前は AI / AI以外 で分けていたが、それは母集団の偏りを均すための便宜的な分割で、
 * 「読者が何のために読むか」とは対応していなかった。予算はレーンに与える。
 *
 * 足りないレーンがある日は、余っているレーンで埋める（枠を空けたまま件数を減らさない）。
 * これは「その日は該当が無かった」場合の話で、しきい値がずれている場合の
 * 補充は候補選定側（lanes.ts）で先に済んでいる。
 */
export function pickByLane<T extends { lane: Lane }>(
  ranked: readonly T[],
  total: number,
  /** security の件数。等分の外で別に取る（既存レーンの枠を削らないため） */
  securityTotal = 0,
): Record<Lane, T[]> {
  const quota = Math.floor(total / GENERAL_LANES.length);
  const picked: Record<Lane, T[]> = { security: [], know: [], build: [] };

  picked.security = ranked.filter((i) => i.lane === 'security').slice(0, securityTotal);
  for (const lane of GENERAL_LANES) {
    picked[lane] = ranked.filter((i) => i.lane === lane).slice(0, quota);
  }

  // 端数と、埋まらなかったレーンのぶんを、残りからスコア順で配る（security は対象外）
  const taken = new Set<T>(LANES.flatMap((lane) => picked[lane]));
  let remaining = total - GENERAL_LANES.reduce((n, lane) => n + picked[lane].length, 0);
  if (remaining > 0) {
    for (const item of ranked) {
      if (remaining <= 0) break;
      if (taken.has(item) || item.lane === 'security') continue;
      picked[item.lane].push(item);
      taken.add(item);
      remaining--;
    }
  }

  return picked;
}
