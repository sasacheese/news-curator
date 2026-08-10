import type { Lane, PreScoredItem } from './types.js';
import { LANES } from './types.js';
import { extractTerms } from './util.js';

/* ------------------------------------------------------------------ *
 * レーンの事前フィルタ
 *
 * 以前は preScore 1 本で 600 件を 150 件に絞っていた。preScore の主項は
 * トピックキーワードの一致なので、この絞り込みは「読者が既に知っている領域か」
 * を測っていたことになる。3 つの目的のうち「知る」の一部しか通らない。
 *
 *   - 大きな話題は読者の関心と独立に成立する（サプライチェーン攻撃も
 *     ハードウェアの価格高騰も topics.json には無い）→ 一致で測れない
 *   - 新しいものは、名前がまだ語彙に無いから新しい → 一致とは逆を向く
 *   - 意見が言える記事は二次情報が多い → 一次情報優遇と逆を向く
 *
 * なので目的ごとに別の信号で絞る。3 レーン × 50 件で、LLM に渡す総数は
 * 従来と同じ 150 件のまま。ここは全部ルールベースなので追加コストはゼロ。
 * ------------------------------------------------------------------ */

/**
 * 規模の語彙。「影響範囲 × 取り返しのつかなさ」の代理指標。
 * 技術に限らないことに注意——買収も値上げも規制も「知る」の対象になる。
 */
const CONSEQUENCE_TERMS = [
  // セキュリティ・事故
  '脆弱性', '攻撃', '侵害', '漏洩', '流出', '改ざん', 'サプライチェーン', 'マルウェア',
  '不正アクセス', '障害', '停止', '緊急',
  'vulnerability', 'exploit', 'breach', 'malware', 'compromise', 'supply chain',
  'outage', 'incident', 'backdoor', 'cve-', 'ghsa-', 'zero-day',
  // 打ち切り・移行の強制
  '廃止', 'サポート終了', '提供終了', '移行期限', '非推奨', '打ち切り',
  'deprecat', 'end of life', 'sunset', 'shutting down', 'discontinu', 'breaking change',
  // 経済・制度
  '買収', '合併', '出資', '値上げ', '高騰', '価格改定', '訴訟', '提訴', '規制', '法案',
  '義務化', '独占', '品薄', '供給',
  'acquisition', 'acquires', 'lawsuit', 'antitrust', 'regulation', 'shortage', 'surge',
  // 規模そのもの
  '大規模', '全社', '全面', '世界中', '数百万', '数千万',
];

/**
 * 幹に対する枝の語彙。
 *
 * 幹を知っていれば導けるものは枝である、というのがこのレーンの原則。
 * 語彙だけで幹と枝は切り分けられない（本判定は LLM 側でやる）が、
 * 明らかな続報・派生を候補から押し下げるくらいの効果はある。
 */
const BRANCH_TERMS = [
  'パッチ', 'ホットフィックス', '続報', '詳報', '追記', 'セール', '割引', '在庫',
  '整備済', 'まとめ記事', '一覧表',
  'hotfix', 'patch release', 'roundup', 'weekly', 'digest', 'changelog for',
];

/** 「新しいものが出た」の語彙。触れる実体があるかは別途 tangible で見る */
const DEBUT_TERMS = [
  '公開しました', 'リリースしました', '作りました', '作った', '個人開発', 'つくった',
  '初公開', '登場', 'オープンソース化', '一般提供', '正式リリース', '爆誕', '新しい',
  'introducing', 'announcing', 'launch', 'show hn', 'first release', 'now available',
  'open sourced', 'general availability', 'v1.0', '1.0.0', 'public beta', 'alpha release',
];

/** 手を動かせる実体があることの語彙。「すごそう」と「試せる」を分ける */
const TANGIBLE_TERMS = [
  'npm install', 'npx ', 'pnpm add', 'yarn add', 'pip install', 'cargo install',
  'brew install', 'docker run', 'go install', 'uvx ', 'curl -',
  'インストール', '導入手順', '使い方', 'セットアップ', 'クイックスタート',
  'getting started', 'quickstart', 'installation',
];

/**
 * 立場が割れることの語彙。
 *
 * 賛否の本質は「事実が争われている」ことではなく「優先順位が争われている」こと。
 * 速さ vs 安全、自動化 vs 制御、統一 vs 自由。同じ事実から違う結論が出るとき、
 * そこに立場が生まれる。その気配が出やすい言い回しを集めている。
 */
const CONTENTION_TERMS = [
  '賛否', '反論', '批判', '異論', '議論', '主張', '意見', '思想', '再考', '見直す',
  'やめた', 'やめました', 'やめるべき', 'べきか', 'べきではない', '本当に', '本当は',
  'アンチパターン', '間違い', '誤解', '神話', '幻想', '限界', '向いていない',
  '不要', '要らない', 'は死んだ', 'つらい', '失敗', '後悔', 'なぜ',
  'considered harmful', 'is dead', 'stop using', "don't use", 'rethinking', 'myth',
  'wrong', 'against', 'why i', 'we ditched', 'we moved', 'lessons learned', 'postmortem',
  'unpopular', 'debate', 'controversial', 'overrated', 'overkill',
];

export interface LaneAffinity {
  know: number;
  build: number;
  talk: number;
}

export interface LaneContext {
  /** 直近のダイジェストに出てきた語。build レーンの「初出性」に使う */
  seenTerms: ReadonlySet<string>;
  /** 直近のダイジェストで扱ったトピック名の頻度。know レーンの続報抑制に使う */
  recentTopicCounts: ReadonlyMap<string, number>;
}

export const EMPTY_LANE_CONTEXT: LaneContext = {
  seenTerms: new Set(),
  recentTopicCounts: new Map(),
};

function haystack(item: PreScoredItem): string {
  // 本文の頭だけ見る。長いリリースノートの末尾まで拾うと語彙判定が当たらなくなる
  return `${item.title} ${item.tags.join(' ')} ${item.snippet} ${(item.body ?? '').slice(0, 2000)}`.toLowerCase();
}

function hits(hay: string, terms: readonly string[]): number {
  let n = 0;
  for (const t of terms) if (hay.includes(t)) n++;
  return n;
}

/** 0〜1 に収める。1 個当たれば 0.5、3 個で 0.9 くらいの伸び方 */
function saturate(n: number, half = 1): number {
  return n <= 0 ? 0 : n / (n + half);
}

/**
 * 複数のプラットフォームで同時に取り上げられているか。
 *
 * 「大きな話題」の一番素直な機械的証拠。Qiita だけで伸びている記事と、
 * Qiita と HN とはてブの 3 か所から見つかった記事では意味が違う。
 */
function reach(item: PreScoredItem): number {
  const sources = item.foundIn?.length ?? 1;
  const m = item.metrics;
  const cross = Math.min(0.4, (sources - 1) * 0.2);
  const hatena = Math.min(0.3, (m.hatena ?? 0) / 100);
  const hn = Math.min(0.3, (m.points ?? 0) / 800);
  return Math.min(1, cross + Math.max(hatena, hn) + (item.buzz ? 0.2 : 0));
}

/**
 * know: 影響範囲 × 取り返しのつかなさ。
 *
 * **トピック一致を使わない。** ここが設計上いちばん大事な点で、
 * 関心一致を門番にしている限り、関心の外の重大事は構造的に拾えない。
 */
function knowScore(item: PreScoredItem, hay: string): number {
  const consequence = saturate(hits(hay, CONSEQUENCE_TERMS), 1);
  const branch = saturate(hits(hay, BRANCH_TERMS), 1);
  // 公式の告知は、規模の大きい話の一次情報になりやすい
  const primary =
    item.source === 'rss' || item.source === 'github_release' || item.source === 'changelog'
      ? 0.12
      : 0;
  /*
   * 語彙だけで通るのは 3 語以上当たったとき（0.75 × 0.6 = 0.45）。
   * 2 語なら 0.40 で、そこに少しでも広がりの証拠があれば通る。
   * 大きな話題は人気指標を持たないソース（公式ブログ・報道系フィード）から
   * 来ることがあるので、reach ゼロでも通る道を残しておく必要がある。
   */
  return clamp01(consequence * 0.6 + reach(item) * 0.35 + primary - branch * 0.25);
}

/**
 * build: 可能性の差分 × 触れる実体。
 *
 * 「速くなった・便利になった」は程度の改善で、差分ではない。それを語彙で
 * 見分けるのは無理なので、ここでは「初出であること」「今日試せる形をしていること」
 * までを機械的に測り、可能性の差分そのものの判定は LLM に渡す。
 *
 * どのレーンにも寄らなかったものが落ちてくる既定のレーンでもあるので、
 * 既存の関心トピック一致（preScore）もここで効かせる。従来の
 * 「自分のスタックの実装ノウハウ」はこのレーンに吸収される。
 */
function buildScore(item: PreScoredItem, hay: string, ctx: LaneContext): number {
  const debut = saturate(hits(hay, DEBUT_TERMS), 1);
  const tangible = item.source === 'github_repo' ? 1 : saturate(hits(hay, TANGIBLE_TERMS), 1);

  // タイトルに含まれる語のうち、過去のダイジェストで一度も見ていない割合
  const terms = extractTerms(item.title);
  const unseen = terms.filter((t) => !ctx.seenTerms.has(t)).length;
  const novelty = terms.length === 0 ? 0 : unseen / terms.length;

  return clamp01(
    novelty * 0.3 + debut * 0.25 + tangible * 0.2 + item.preScore * 0.25,
  );
}

/**
 * talk: 立場が割れること。
 *
 * いちばん信頼できる証拠は語彙ではなく discussion の量比。
 * 人気の割にコメントが多い記事は、ほぼ確実に何かが争われている。
 * この比は metrics.points / metrics.comments で既に取れている。
 */
function talkScore(item: PreScoredItem, hay: string): number {
  const m = item.metrics;
  const points = m.points ?? m.likes ?? m.hatena ?? 0;
  const comments = m.comments ?? 0;
  // 賛同だけなら star が伸びてコメントは伸びない。割れているとコメント側が伸びる
  const ratio = points > 0 ? Math.min(1, comments / Math.max(1, points * 0.35)) : 0;
  const vocabulary = saturate(hits(hay, CONTENTION_TERMS), 1.2);
  const question = /[?？]\s*$|かのか$|べきか|のか[?？]?$/.test(item.title.trim()) ? 0.15 : 0;
  // 話題になっていない意見記事は、そもそも共通の話題にならない
  const visibility = Math.min(0.25, item.popularityPercentile * 0.25);

  return clamp01(vocabulary * 0.45 + ratio * 0.3 + visibility + question);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function laneAffinity(item: PreScoredItem, ctx: LaneContext): LaneAffinity {
  const hay = haystack(item);
  return {
    know: knowScore(item, hay),
    build: buildScore(item, hay, ctx),
    talk: talkScore(item, hay),
  };
}

export interface LaneThresholds {
  know: number;
  talk: number;
}

/**
 * レーンを 1 つだけ割り当てる。
 *
 * argmax は使わない。3 つのスコアは別の信号から作っていて尺度が揃っておらず、
 * 素点を比べても意味が無いため。代わりに「know の要件を満たすか」「talk の要件を
 * 満たすか」を順に見て、どちらでもなければ build に落とす。build が既定の
 * レーンなのは、それが従来の動作（関心トピックの実装ノウハウ）の行き先だから。
 *
 * しきい値は環境変数で動かせるようにしてある。実データを見ないと適正値は
 * 決められないので、ログにレーン別の件数を出して調整できる形にした。
 */
export function assignLane(affinity: LaneAffinity, thresholds: LaneThresholds): Lane {
  if (affinity.know >= thresholds.know) return 'know';
  if (affinity.talk >= thresholds.talk) return 'talk';
  return 'build';
}

export interface LaneSelection {
  candidates: Record<Lane, PreScoredItem[]>;
  /** しきい値で振り分けた時点の件数。調整のためにログへ出す */
  assigned: Record<Lane, number>;
}

/**
 * レーンごとの LLM 採点候補を選ぶ。
 *
 * しきい値の当たり外れで候補が空になると、その日はそのレーンが丸ごと消える。
 * それは「今日は大きな話題が無かった」ではなく「しきい値がずれていた」の
 * 可能性が高いので、枠が埋まらないレーンは、そのレーンのスコア順で
 * 他レーンから補充する。補充しても取り合いにならないよう、確保済みの id は
 * 全レーンで共有する。
 */
export function selectLaneCandidates(
  items: readonly PreScoredItem[],
  perLane: number,
  ctx: LaneContext,
  thresholds: LaneThresholds,
): LaneSelection {
  const scored = items.map((item) => ({ item, affinity: laneAffinity(item, ctx) }));

  const buckets: Record<Lane, typeof scored> = { know: [], build: [], talk: [] };
  for (const entry of scored) buckets[assignLane(entry.affinity, thresholds)].push(entry);

  const assigned = { know: buckets.know.length, build: buckets.build.length, talk: buckets.talk.length };
  const candidates: Record<Lane, PreScoredItem[]> = { know: [], build: [], talk: [] };
  const taken = new Set<string>();

  // know から埋める。取りこぼしたときの損失がいちばん大きいレーンなので先に確保する
  for (const lane of LANES) {
    const picked = buckets[lane]
      .slice()
      .sort((a, b) => b.affinity[lane] - a.affinity[lane])
      .filter((e) => !taken.has(e.item.id))
      .slice(0, perLane);
    for (const e of picked) taken.add(e.item.id);
    candidates[lane] = picked.map((e) => e.item);
  }

  /*
   * 埋まらなかったレーンは、そのレーンのスコア順で他から補充する。
   * affinity が 0 のものも入れる——ここで枠を捨てると LLM に見せる機会自体が
   * 消えるので、「その日は該当が無かった」のか「しきい値がずれていた」のかを
   * 判定できなくなる。中身が薄いままだった場合は、採点後のスコア下限
   * （index.ts の minTopScore / minOtherScore）で落ちる。
   */
  for (const lane of LANES) {
    if (candidates[lane].length >= perLane) continue;
    const fill = scored
      .filter((e) => !taken.has(e.item.id))
      .sort((a, b) => b.affinity[lane] - a.affinity[lane])
      .slice(0, perLane - candidates[lane].length);
    for (const e of fill) taken.add(e.item.id);
    candidates[lane].push(...fill.map((e) => e.item));
  }

  return { candidates, assigned };
}
