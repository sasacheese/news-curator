import type { PreScoredItem, RawItem, SourceKind, TopicsConfig } from './types.js';
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
    default:
      return 0;
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
    };
  });
}

/**
 * 上位 n 件を選ぶ。同じ発信元が枠を独占しないよう、まず 1 ソース 1 件で埋め、
 * 足りなければスコア順に補充する。
 * （例: 同じ日に nodejs/node のリリースが 3 本出ても、ベスト3が全部それにならないようにする）
 */
export function pickTopDiverse<T extends { id: string; sourceLabel: string; score: number }>(
  ranked: readonly T[],
  n: number,
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

  return picked.sort((a, b) => b.score - a.score);
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
      byUrl.set(key, item);
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
      metrics: {
        likes: Math.max(winner.metrics.likes ?? 0, loser.metrics.likes ?? 0) || undefined,
        stocks: Math.max(winner.metrics.stocks ?? 0, loser.metrics.stocks ?? 0) || undefined,
        stars: Math.max(winner.metrics.stars ?? 0, loser.metrics.stars ?? 0) || undefined,
        points: Math.max(winner.metrics.points ?? 0, loser.metrics.points ?? 0) || undefined,
        comments: Math.max(winner.metrics.comments ?? 0, loser.metrics.comments ?? 0) || undefined,
        hatena: Math.max(winner.metrics.hatena ?? 0, loser.metrics.hatena ?? 0) || undefined,
      },
    });
  }

  const seenTitles = new Set<string>();
  const out: RawItem[] = [];
  for (const item of byUrl.values()) {
    // 外部 API / RSS 由来の link は信用しない（javascript: などを保存させない）
    if (!isHttpUrl(item.url)) continue;
    if (seenUrls.has(normalizeUrl(item.url))) continue;
    const tk = titleKey(item.title);
    if (tk.length >= 8) {
      if (seenTitles.has(tk)) continue;
      seenTitles.add(tk);
    }
    out.push(item);
  }
  return out;
}
