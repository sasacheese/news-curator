import type { Lane, PreScoredItem } from './types.js';
import { LANES } from './types.js';

/* ------------------------------------------------------------------ *
 * security: 事案の語彙
 *
 * 規模の語彙（CONSEQUENCE_TERMS）と重なるが、こちらは「攻撃・漏洩の事案か」だけを見る。
 * 障害・廃止・買収は know の仕事なので入れない。
 * ------------------------------------------------------------------ */
const SECURITY_TERMS = [
  '脆弱性', '情報漏洩', '情報漏えい', '漏洩', '漏えい', '流出', '不正アクセス', 'サイバー攻撃',
  'ランサムウェア', 'マルウェア', 'フィッシング', '標的型', '乗っ取り', 'ゼロデイ', '侵害',
  'サプライチェーン攻撃', '認証情報', 'クレデンシャル', '改ざん', 'バックドア', '不正ログイン',
  'vulnerability', 'exploit', 'breach', 'data leak', 'leaked', 'ransomware', 'malware',
  'phishing', 'zero-day', '0-day', 'compromise', 'credential', 'backdoor', 'supply chain attack',
  'infostealer', 'cve-', 'ghsa-', 'threat actor', 'apt',
];

/* ------------------------------------------------------------------ *
 * レーンの事前フィルタ
 *
 * 以前は preScore 1 本で 600 件を 150 件に絞っていた。preScore の主項は
 * トピックキーワードの一致なので、この絞り込みは「読者が既に知っている領域か」
 * を測っていたことになる。目的のうち「知る」の一部しか通らない。
 *
 *   - 大きな話題は読者の関心と独立に成立する（サプライチェーン攻撃も
 *     ハードウェアの価格高騰も topics.json には無い）→ 一致で測れない
 *   - 試したくなるかは「今日動かせる形か」で決まる → 一致では測れない
 *
 * なので目的ごとに別の信号で絞る。ここは全部ルールベースなので追加コストはゼロ。
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

export interface LaneAffinity {
  /** 無ければ 0 とみなす（security 導入前のテストと設定が書いたまま通るように） */
  security?: number;
  know: number;
  build: number;
}

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
 * 見分けるのは無理なので、ここでは「今日試せる形をしていること」までを機械的に測り、
 * 可能性の差分そのものの判定は LLM に渡す。
 *
 * **「初出性」（過去のダイジェストに出ていない語の割合）は使わない。**
 * 以前は最大の重み（0.3）を与えていたが、あれは新しさではなく**無名さ**を測っていた。
 * 無名な語だけで構成されたタイトル——個人の小さなリポジトリ——が満点を取り、
 * 有名なツールの重要なリリースは語が既知なので沈む。実測で 1 位が誰も知らない
 * 個人リポジトリになったのはこれが原因で、出たことのない単語だから価値がある、
 * という前提そのものが成り立っていなかった。
 *
 * 重みは「触れる実体」に寄せてある。このレーンの行動変容は「試したくなる」なので、
 * 今日インストールして動かせる形をしているかが、いちばん効く証拠になる。
 *
 * どのレーンにも寄らなかったものが落ちてくる既定のレーンでもあるので、
 * 既存の関心トピック一致（preScore）もここで効かせる。従来の
 * 「自分のスタックの実装ノウハウ」はこのレーンに吸収される。
 */
function buildScore(item: PreScoredItem, hay: string): number {
  const debut = saturate(hits(hay, DEBUT_TERMS), 1);
  const tangible = item.source === 'github_repo' ? 1 : saturate(hits(hay, TANGIBLE_TERMS), 1);

  return clamp01(tangible * 0.4 + debut * 0.35 + item.preScore * 0.25);
}

/**
 * security: 攻撃・漏洩の事案か。
 *
 * セキュリティ系のフィード（watchlist の category: "security"）は定義上そうなので 1。
 * それ以外は、見出しに語彙があれば強く、本文だけなら 2 語以上で届く強さにする。
 * 本文に「攻撃」と 1 回書いてあるだけの設計記事まで吸い込まないため。
 */
function securityScore(item: PreScoredItem, hay: string): number {
  if (item.feedCategory === 'security') return 1;
  const title = item.title.toLowerCase();
  const inTitle = SECURITY_TERMS.some((t) => title.includes(t)) ? 0.6 : 0;
  return clamp01(Math.max(inTitle, saturate(hits(hay, SECURITY_TERMS), 1.5)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function laneAffinity(item: PreScoredItem): LaneAffinity {
  const hay = haystack(item);
  return {
    security: securityScore(item, hay),
    know: knowScore(item, hay),
    build: buildScore(item, hay),
  };
}

export interface LaneThresholds {
  /** 無ければ security には振り分けない */
  security?: number;
  know: number;
}

/**
 * レーンを 1 つだけ割り当てる。
 *
 * argmax は使わない。レーンごとのスコアは別の信号から作っていて尺度が揃っておらず、
 * 素点を比べても意味が無いため。代わりに「know の要件を満たすか」を見て、
 * 満たさなければ build に落とす。build が既定の
 * レーンなのは、それが従来の動作（関心トピックの実装ノウハウ）の行き先だから。
 *
 * しきい値は環境変数で動かせるようにしてある。実データを見ないと適正値は
 * 決められないので、ログにレーン別の件数を出して調整できる形にした。
 */
export function assignLane(affinity: LaneAffinity, thresholds: LaneThresholds): Lane {
  // security を先に見る。事案は規模の語彙にも当たるので、know が先だと全部 know に取られる
  if (thresholds.security != null && (affinity.security ?? 0) >= thresholds.security) {
    return 'security';
  }
  if (affinity.know >= thresholds.know) return 'know';
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
  thresholds: LaneThresholds,
  /** security だけ別の上限にする。省略時は perLane */
  securityPerLane: number = perLane,
): LaneSelection {
  const limit = (lane: Lane) => (lane === 'security' ? securityPerLane : perLane);
  const scored = items.map((item) => ({ item, affinity: laneAffinity(item) }));

  const buckets: Record<Lane, typeof scored> = { security: [], know: [], build: [] };
  for (const entry of scored) buckets[assignLane(entry.affinity, thresholds)].push(entry);

  const assigned = {
    security: buckets.security.length,
    know: buckets.know.length,
    build: buckets.build.length,
  };
  const candidates: Record<Lane, PreScoredItem[]> = { security: [], know: [], build: [] };
  const taken = new Set<string>();

  // LANES の順（security → know → …）で埋める。取りこぼしの損失が大きい順に確保する
  for (const lane of LANES) {
    const picked = buckets[lane]
      .slice()
      .sort((a, b) => (b.affinity[lane] ?? 0) - (a.affinity[lane] ?? 0))
      .filter((e) => !taken.has(e.item.id))
      .slice(0, limit(lane));
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
    /*
     * security は補充しない。事案でない記事を「その日のセキュリティ」として
     * 採点に回しても、出てくるのは無関係な記事の要約だけで、空の日より悪い。
     */
    if (lane === 'security') continue;
    if (candidates[lane].length >= perLane) continue;
    const fill = scored
      .filter((e) => !taken.has(e.item.id))
      .sort((a, b) => (b.affinity[lane] ?? 0) - (a.affinity[lane] ?? 0))
      .slice(0, perLane - candidates[lane].length);
    for (const e of fill) taken.add(e.item.id);
    candidates[lane].push(...fill.map((e) => e.item));
  }

  return { candidates, assigned };
}
