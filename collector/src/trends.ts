import type {
  IndexEntry,
  PreScoredItem,
  RawItem,
  TrendArticle,
  TrendBoard,
  TrendDay,
  TrendPlacement,
  TrendState,
  TrendTopic,
} from './types.js';

/* ------------------------------------------------------------------ *
 * 話題台帳（トレンド）
 *
 * 「最新情報」と「トレンド」は別物である、というのがこのモジュールの前提。
 * ダイジェスト本体は前日 7:00 〜 当日 7:00 に公開されたものだけを扱うので、
 * 3 日続いている話題は 2 日目以降どこにも出ない。ここでは記事ではなく
 * 「話題」を単位にして、日をまたいだ状態を持つ。
 *
 * LLM は一切通さない。全部ルールベースなので追加費用はゼロ。
 * ------------------------------------------------------------------ */

/** 台帳の保持期間。これより古い日は落とす */
export const LEDGER_DAYS = 28;
/** スパークラインに出す日数 */
const SPARK_DAYS = 14;
/** 平常値を取る日数 */
const BASELINE_DAYS = 14;
/** 「続いているか」を見る直近の窓 */
const RECENT_DAYS = 5;
/**
 * 背景とみなすライン。台帳の 7 割以上の日に出ている語は関心領域そのもの。
 *
 * これは**一覧から外すためではなく、何を外したかを見せるため**に使う。
 * 母集団 572 件を実測したところ、`Python` `Claude` `Git` のような語は毎日出る。
 * 出現の有無で「継続中」を判定すると、この種の語だけで埋まる。だから
 * 判定の主軸は presence ではなく水準（share）にしてある。
 */
const BACKGROUND_PRESENCE = 0.7;
/** これ未満の履歴では平常比も「落ち着いた」も判定できない */
export const MIN_HISTORY_DAYS = 5;

/**
 * 今日動いた: 当日これ以上の本数があり、かつ平常比がこれ以上。
 * 母集団 572 件の実測で、当日 3 本以上に該当するのは 76 話題。ここから平常比で絞る。
 */
const HOT_MIN_TODAY = 3;
const HOT_MIN_LIFT = 1.8;
/**
 * 追跡中: 直近 5 日の水準が平常のこれ以上で、直近 3 日にも出ていて、本数もこれ以上。
 *
 * 「直近 7 日で 3 日以上出ている」で判定していたが、母集団 600 件では
 * ほとんどの語が毎日出るので、これは何も絞れていなかった。続いていることは
 * 出現の有無ではなく**水準が平常より高いまま**であることで測る。
 */
const KEEP_MIN_LIFT = 1.5;
const KEEP_MIN_RECENT = 4;
/**
 * 落ち着いた: 7〜4 日前にこれ以上出ていて、直近 3 日の水準がその 4 割以下。
 *
 * 「直近 3 日が 0 本」では判定できない（母集団が大きいと少しは出続ける）。
 * 終わったかどうかは、絶対数ではなく勢いの落ち方で見る。
 */
const COOL_MIN_BEFORE = 3;
const COOL_MAX_REMAINING = 0.4;

const MAX_HOT = 6;
const MAX_KEEP = 8;
const MAX_COOL = 6;
const MAX_UBIQUITOUS = 8;

/** タイムラインに既定で見せる日数と、畳んだぶんを含む上限 */
const TIMELINE_DAYS = 3;
const MAX_TIMELINE = 12;
/** 今日の未掲載記事をタイムラインに足す上限 */
const MAX_UNPLACED_TODAY = 2;

/**
 * 語彙に入れる最低出現回数。
 *
 * 1 にしてある。タグを語彙から外したので、残る種は LLM が名前として選んだ
 * keywords だけ——1 回しか出ていなくても名前としては正しい。2 にすると
 * `Cursor Origin` のような**掲載 1 回の新顔がまるごと落ちる**。これは
 * 拾いたいものの中心なので、ここで切ってはいけない。
 * 単発の語が話題として出てしまうことは、台帳側（trimLedger）と
 * 当日の本数下限（HOT_MIN_TODAY）で防ぐ。
 */
const VOCAB_MIN_COUNT = 1;
/** 台帳に残す話題の上限。ファイルが太らないように上位だけ持つ */
const MAX_LEDGER_TOPICS = 600;
/**
 * 台帳に残す最低本数（保持期間の合計）。
 *
 * 語彙の下限（VOCAB_MIN_COUNT）とは別。語彙は名前として 1 回でも正しいが、
 * 台帳に 1 本だけの話題を残しても、水準の比較には使えない。
 */
const LEDGER_MIN_TOTAL = 2;
/** これ以上あれば、単語が足された表記でも独立した話題として扱う */
const INDEPENDENT_MIN = 5;

/** 数字とバージョン記号だけで出来ている語 */
const VERSION_ONLY = /^[vV]?[\d][\w.\-]*$/;
/**
 * 親名を引いた残りが版名・型番だけか（`Qwen3.8-27B` の `3.8-27B`）。
 *
 * ここに「大文字始まりの語」を含めていたときは `Claude Code` の ` Code` も
 * 版名と見なされ、別の製品の話が `Claude` の山に畳まれた。数字で始まるものだけ。
 */
const REMAINDER_IS_VERSION = /^[\s\-_./]*[vV]?[\d][\w.\-]*$/;
const ASCII_ONLY = /^[\x20-\x7E]+$/;
/** 2 文字以上の語が含まれるか（変種として意味があるかの判定） */
const HAS_WORD = /[A-Za-z]{2,}|[ぁ-んァ-ヶ一-龠]{2,}/;

/**
 * 表記統合キー。
 *
 * NFKC・小文字化して区切り記号を落とし、ASCII 語の末尾複数形も揃える。
 * `TanStack/router` と `TanStack Router`、`AI agent` と `AI agents` を
 * 別の話題として数えると、どちらも本数が足りずに消える。
 */
export function topicKey(s: string): string {
  let k = s.normalize('NFKC').toLowerCase().replace(/[\s/_.\-]/g, '');
  if (ASCII_ONLY.test(k) && k.length > 4 && k.endsWith('s')) k = k.slice(0, -1);
  return k;
}

/**
 * 話題名として情報量がゼロの語。
 *
 * 「AI が話題です」と言われて動くものは何も無い。カテゴリ語・抽象語は
 * topics.json が担当する関心領域そのもので、動きを測る対象ではない。
 */
const STOP_WORDS = new Set(
  /*
   * 照合は正規化キー同士で行うので、ここも同じ正規化を通しておく。
   * 生の文字列で持っていたときは `Hacker News` が素通りした（キーは `hackernew`）。
   */
  [
  'ai', 'llm', 'ai/llm', 'aiエージェント', 'aiコーディング', 'ai駆動開発', 'ai業界',
  'agent', 'agents', 'aiagent', 'tool', 'tools', 'app', 'apps', 'web', 'code', 'coding',
  'model', 'models', 'api', 'sdk', 'cli', 'ui', 'ux', 'os', 'ide', 'cpu', 'gpu', 'pdf',
  'ssr', 'csr', 'rag', 'http', 'https', 'json', 'yaml', 'oss', 'pro', 'oop', 'poc',
  'エージェント', 'セキュリティ', '自動化', 'コードレビュー', 'プライバシー', 'テスト',
  'パフォーマンス', '設計', '開発', '運用', '監視', 'ログ', '認証', '決済', '型安全',
  'プラグイン', 'キャッシュ', 'コーディング', 'トークン', 'セッション', 'ドキュメント',
  'ライブラリ', 'フレームワーク', 'オープンソース', '生成ai', '機械学習', 'プロンプト',
  'リファクタリング', 'アーキテクチャ', 'エンジニア', 'プログラミング', 'ソフトウェア',
  'チュートリアル', 'ハンズオン', 'まとめ', 'メモ', '備忘録', '入門', '初心者',
  'コンテキスト', '公式ドキュメント', '優先順位', 'ベストプラクティス', '実装', '検証',
  'security', 'release', 'update', 'system', 'tech', 'cloud', 'container', 'network',
  // 収集元の名前。どこから来たかは話題ではない
  'hacker news', 'qiita', 'zenn', 'dev.to', 'note', 'はてなブックマーク',
  ].map(topicKey),
);

export interface Vocabulary {
  /** 表記統合キー -> 表示名 */
  labels: Map<string, string>;
  /** 表記統合キー -> 照合用の正規表現 */
  patterns: Map<string, RegExp>;
  /** 子キー -> 親キー（ファミリ束ね） */
  parents: Map<string, string>;
}

function isVocabCandidate(term: string): boolean {
  if (term.length < 3) return false;
  if (VERSION_ONLY.test(term)) return false;
  if (STOP_WORDS.has(topicKey(term))) return false;
  // URL や文になっているものは語彙ではない
  if (/[。、！？「」（）\n]/.test(term)) return false;
  if (term.length > 40) return false;
  return true;
}

/**
 * 語彙を作る。
 *
 * 種にするのは**構造化された・人が付けた名前だけ**にしている。タイトルから
 * 固有名詞を機械的に切り出す方式を試したが、部分文字列一致が単語境界を
 * 無視して `RCE` が "source" に、`Pro` が "Provenance" に当たった。
 * 語彙の質がこの機能の質を決めるので、ここは推測しない。
 *
 *   - 過去の掲載記事の keywords（LLM が名前として選んだ語。表記が正しい）
 *   - GitHub の owner/repo（構造化されている）
 *
 * タグ（Qiita / Zenn）も試したが使っていない。書き手が付けた名前なので信用できる
 * はずが、実測の上位が `システム` `tech` `release` `個人開発` `Qiita` で埋まった。
 * タグは分類のための語で、話題の名前ではない。owner/repo も **リポジトリ名だけは
 * 足さない**——`router` `servers` `container` のような一般語になる。
 *
 * 代わりに新しい話題は「一度掲載されたら翌日から語彙に入る」経路で拾う。
 * 1 日遅れるが、名前の質を推測で埋めるより確実。
 */
export function buildVocabulary(
  pastKeywords: readonly string[],
  items: readonly RawItem[],
): Vocabulary {
  const counts = new Map<string, Map<string, number>>();
  const add = (term: string) => {
    const t = term.trim();
    if (!isVocabCandidate(t)) return;
    const key = topicKey(t);
    if (!key) return;
    const surfaces = counts.get(key) ?? new Map<string, number>();
    surfaces.set(t, (surfaces.get(t) ?? 0) + 1);
    counts.set(key, surfaces);
  };

  for (const kw of pastKeywords) add(kw);
  for (const item of items) {
    if (item.source === 'github_repo' || item.source === 'github_release') {
      const repo = item.title.match(/^[\w.\-]+\/[\w.\-]+/);
      if (repo) add(repo[0]);
    }
  }

  const labels = new Map<string, string>();
  for (const [key, surfaces] of counts) {
    let total = 0;
    let best = '';
    let bestN = 0;
    for (const [surface, n] of surfaces) {
      total += n;
      if (n > bestN) {
        bestN = n;
        best = surface;
      }
    }
    if (total < VOCAB_MIN_COUNT) continue;
    labels.set(key, best);
  }

  return { labels, patterns: buildPatterns(labels), parents: buildFamilies(labels, counts) };
}

function buildPatterns(labels: ReadonlyMap<string, string>): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const [key, label] of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 日本語には単語境界が無いのでそのまま。ASCII は境界を要求する
    patterns.set(
      key,
      ASCII_ONLY.test(label)
        ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i')
        : new RegExp(escaped, 'i'),
    );
  }
  return patterns;
}

/**
 * ファミリに束ねる。`Qwen3.8-27B` は `Qwen` の一員として数える。
 *
 * ただし独立した存在感を持つ子は束ねない。`Claude Code` を `Claude` に
 * 畳むと、別の製品の話が 1 つの山になる。判定は「残りが版名か」と
 * 「子が単独で十分出ているか」の 2 つ。
 */
function buildFamilies(
  labels: ReadonlyMap<string, string>,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, string> {
  const parents = new Map<string, string>();
  const keys = [...labels.keys()].sort((a, b) => a.length - b.length);
  const totalOf = (key: string) => {
    let n = 0;
    for (const v of counts.get(key)?.values() ?? []) n += v;
    return n;
  };

  for (const child of labels.keys()) {
    for (const root of keys) {
      if (root === child || root.length < 3 || !child.startsWith(root)) continue;
      const childLabel = labels.get(child)!;
      const rootLabel = labels.get(root)!;
      const remainder = childLabel.toLowerCase().startsWith(rootLabel.toLowerCase())
        ? childLabel.slice(rootLabel.length)
        : child.slice(root.length);
      // 版名の差は必ず畳む。単語が足されている場合は、子が独立して出ていれば畳まない
      if (!REMAINDER_IS_VERSION.test(remainder) && totalOf(child) >= INDEPENDENT_MIN) continue;
      parents.set(child, root);
      break;
    }
  }
  return parents;
}

function canonical(key: string, parents: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  let k = key;
  while (parents.has(k) && !seen.has(k)) {
    seen.add(k);
    k = parents.get(k)!;
  }
  return k;
}

/**
 * テキストに出現する語彙を返す（ファミリに束ねる前の実表記キー）。
 *
 * 長い一致に文字列として含まれる短い一致は落とす。`DeepSeek Harness` の
 * 記事で `Harness` を別の話題として数えると、同じ山が 2 つ立つ。
 */
function matchLeaves(text: string, vocab: Vocabulary): string[] {
  const hit: string[] = [];
  for (const [key, pattern] of vocab.patterns) {
    if (pattern.test(text)) hit.push(key);
  }
  return hit.filter((k) => !hit.some((o) => o !== k && o.includes(k)));
}

/** テキストに出現する話題（ファミリ束ね後）を返す */
export function matchTopics(text: string, vocab: Vocabulary): Set<string> {
  return new Set(matchLeaves(text, vocab).map((k) => canonical(k, vocab.parents)));
}

function haystack(item: RawItem): string {
  return `${item.title} ${item.tags.join(' ')} ${item.snippet}`;
}

function entryHaystack(entry: IndexEntry): string {
  return `${entry.title} ${entry.summary} ${(entry.keywords ?? []).join(' ')}`;
}

export interface DayCount<T extends RawItem> {
  day: TrendDay;
  /** 話題キー -> その日その話題で出現した記事（プール全体） */
  itemsByTopic: Map<string, T[]>;
  /** 話題キー -> 観測された実表記 */
  variantsByTopic: Map<string, Set<string>>;
}

/** その日のプールを走査して話題ごとの本数を数える */
export function countDay<T extends RawItem>(
  date: string,
  items: readonly T[],
  vocab: Vocabulary,
): DayCount<T> {
  const itemsByTopic = new Map<string, T[]>();
  const variantsByTopic = new Map<string, Set<string>>();

  for (const item of items) {
    const families = new Set<string>();
    for (const key of matchLeaves(haystack(item), vocab)) {
      const family = canonical(key, vocab.parents);
      families.add(family);
      const set = variantsByTopic.get(family) ?? new Set<string>();
      set.add(vocab.labels.get(key)!);
      variantsByTopic.set(family, set);
    }
    for (const family of families) {
      const list = itemsByTopic.get(family) ?? [];
      list.push(item);
      itemsByTopic.set(family, list);
    }
  }

  const counts: Record<string, number> = {};
  for (const [key, list] of itemsByTopic) counts[key] = list.length;

  return { day: { date, pool: items.length, counts }, itemsByTopic, variantsByTopic };
}

/** 台帳へ今日ぶんを足して、保持期間で切る */
export function mergeLedger(past: readonly TrendDay[], today: TrendDay): TrendDay[] {
  const days = [...past.filter((d) => d.date !== today.date), today].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
  return days.slice(-LEDGER_DAYS);
}

/** ファイルを太らせないよう、台帳に残す話題を上位だけに絞る */
export function trimLedger(days: readonly TrendDay[]): TrendDay[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [key, n] of Object.entries(day.counts)) {
      totals.set(key, (totals.get(key) ?? 0) + n);
    }
  }
  const kept = new Set(
    [...totals.entries()]
      .filter(([, n]) => n >= LEDGER_MIN_TOTAL)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LEDGER_TOPICS)
      .map(([key]) => key),
  );
  return days.map((day) => {
    const counts: Record<string, number> = {};
    for (const [key, n] of Object.entries(day.counts)) if (kept.has(key)) counts[key] = n;
    return { ...day, counts };
  });
}

interface Profile {
  key: string;
  total: number;
  today: number;
  firstSeen: string;
  lastSeen: string;
  /** 当日の平常比。比べる過去が無いときは null */
  lift: number | null;
  /** 直近 5 日の平常比。続いているかの判定に使う */
  liftRecent: number | null;
  recentCount: number;
  last3Count: number;
  beforeCount: number;
  activeDays7: number;
  history: number[];
  presence: number;
  /** 勢いが落ちた度合い（直近 3 日の水準 ÷ 7〜4 日前の水準） */
  remaining: number | null;
}

/** その日の母集団に対する比率。母集団の増減で平常比が狂わないようにする */
function shareOf(day: TrendDay, key: string): number {
  const n = day.counts[key] ?? 0;
  return day.pool > 0 ? n / day.pool : 0;
}

function meanShare(days: readonly TrendDay[], key: string): number {
  if (days.length === 0) return 0;
  return days.reduce((sum, d) => sum + shareOf(d, key), 0) / days.length;
}

function sumCount(days: readonly TrendDay[], key: string): number {
  return days.reduce((sum, d) => sum + (d.counts[key] ?? 0), 0);
}

/** a / b。b が 0（＝平常値が取れない）ときは null */
function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function profileOf(key: string, days: readonly TrendDay[], today: string): Profile | null {
  const seen = days.filter((d) => (d.counts[key] ?? 0) > 0);
  if (seen.length === 0) return null;

  const todayDay = days.find((d) => d.date === today);
  const todayN = todayDay ? (todayDay.counts[key] ?? 0) : 0;

  /*
   * 平常値は「当日を除く直近 14 日」の share 平均。生の件数で比べると、
   * ソースを増やした日や閑散日がそのまま急上昇に見える。
   */
  const priorToToday = days.filter((d) => d.date !== today).slice(-BASELINE_DAYS);
  const recent = days.slice(-RECENT_DAYS);
  const priorToRecent = days.slice(0, Math.max(0, days.length - RECENT_DAYS)).slice(-BASELINE_DAYS);
  const last3 = days.slice(-3);
  const before = days.slice(-10, -3);

  const beforeShare = meanShare(before, key);
  const last3Share = meanShare(last3, key);

  return {
    key,
    total: sumCount(days, key),
    today: todayN,
    firstSeen: seen[0]!.date,
    lastSeen: seen[seen.length - 1]!.date,
    lift: ratio(
      todayDay ? shareOf(todayDay, key) : 0,
      meanShare(priorToToday, key),
    ),
    liftRecent: ratio(meanShare(recent, key), meanShare(priorToRecent, key)),
    recentCount: sumCount(recent, key),
    last3Count: sumCount(last3, key),
    beforeCount: sumCount(before, key),
    activeDays7: days.slice(-7).filter((d) => (d.counts[key] ?? 0) > 0).length,
    history: days.slice(-SPARK_DAYS).map((d) => d.counts[key] ?? 0),
    presence: days.length > 0 ? seen.length / days.length : 0,
    remaining: ratio(last3Share, beforeShare),
  };
}

/**
 * 日別本数がぴったり同じ話題を同一視して畳む。
 *
 * 略称は接頭辞では束ねられない（`DSH` は `DeepSeek Harness` の接頭辞ではない）。
 * 辞書を持つのは運用が続かないので、データの側から見る——同じ記事群に当たって
 * いれば日別本数は完全に一致する。実測で `DeepSeek Harness` と `DSH` が
 * 同じ記事 3 件を持つカードとして 2 枚並んだ。
 *
 * 偶然の一致で別物を畳まないよう、出現日が 3 日以上あるものだけを対象にする。
 * 残すのは長い名前の側（`DSH` より `DeepSeek Harness` のほうが読んで分かる）。
 */
function foldDuplicates(
  profiles: readonly Profile[],
  labels: ReadonlyMap<string, string>,
): { profiles: Profile[]; aliases: Map<string, string[]> } {
  const groups = new Map<string, Profile[]>();
  const singles: Profile[] = [];
  for (const p of profiles) {
    const activeDays = p.history.filter((n) => n > 0).length;
    if (activeDays < 3) {
      singles.push(p);
      continue;
    }
    const signature = `${p.history.join(',')}|${p.total}|${p.firstSeen}`;
    const list = groups.get(signature) ?? [];
    list.push(p);
    groups.set(signature, list);
  }

  const kept: Profile[] = [...singles];
  const aliases = new Map<string, string[]>();
  for (const list of groups.values()) {
    if (list.length === 1) {
      kept.push(list[0]!);
      continue;
    }
    const nameOf = (p: Profile) => labels.get(p.key) ?? p.key;
    const sorted = [...list].sort((a, b) => nameOf(b).length - nameOf(a).length);
    const winner = sorted[0]!;
    kept.push(winner);
    aliases.set(
      winner.key,
      sorted.slice(1).map(nameOf),
    );
  }
  return { profiles: kept, aliases };
}

/** 名前との差が数字・記号だけの表記は変種として出さない */
export function meaningfulVariant(variant: string, name: string): boolean {
  if (topicKey(variant) === topicKey(name)) return false;
  const remainder = variant.toLowerCase().startsWith(name.toLowerCase())
    ? variant.slice(name.length)
    : variant;
  return HAS_WORD.test(remainder);
}

function placementOf(entry: IndexEntry): TrendPlacement {
  if (entry.category === 'リリース/アップデート') return 'release';
  if (entry.rank != null) return 'top';
  if (entry.lane) return 'other';
  return 'other';
}

/**
 * タイムラインを組む。
 *
 * 既定で見せるのは「日付の違う 3 件」。同じ日の複数本を並べると全部 NEW に
 * なって、この話題がどこまで来たのかが見えなくなる。1 日 1 件を代表にして、
 * 残りは畳む。代表はその日の掲載順位つき（読者が見たはずのもの）を優先する。
 */
function buildTimeline(
  topicKeyName: string,
  publishedByTopic: ReadonlyMap<string, IndexEntry[]>,
  unplacedToday: readonly RawItem[],
): TrendArticle[] {
  const published = publishedByTopic.get(topicKeyName) ?? [];
  const articles: TrendArticle[] = published.map((entry) => ({
    date: entry.date,
    title: entry.title,
    url: entry.url,
    placement: placementOf(entry),
    lane: entry.lane,
    rank: entry.rank,
  }));

  for (const item of unplacedToday.slice(0, MAX_UNPLACED_TODAY)) {
    articles.push({
      date: item.publishedAt.slice(0, 10),
      title: item.title,
      url: item.url,
      placement: 'none',
      lane: null,
      rank: null,
    });
  }

  const byDate = new Map<string, TrendArticle[]>();
  for (const article of articles) {
    const list = byDate.get(article.date) ?? [];
    list.push(article);
    byDate.set(article.date, list);
  }

  const rankOf = (a: TrendArticle) =>
    a.rank != null ? a.rank : a.placement === 'none' ? 98 : 50;
  const dates = [...byDate.keys()].sort().reverse();
  const lead: TrendArticle[] = [];
  const rest: TrendArticle[] = [];
  for (const date of dates) {
    const sorted = byDate.get(date)!.sort((a, b) => rankOf(a) - rankOf(b));
    lead.push(sorted[0]!);
    rest.push(...sorted.slice(1));
  }

  const shown = lead.slice(0, TIMELINE_DAYS);
  const hidden = [...lead.slice(TIMELINE_DAYS), ...rest].sort((a, b) =>
    a.date < b.date ? 1 : -1,
  );
  return [...shown, ...hidden].slice(0, MAX_TIMELINE);
}

export interface BuildBoardInput {
  date: string;
  updatedAt: string;
  days: readonly TrendDay[];
  labels: ReadonlyMap<string, string>;
  variantsByTopic: ReadonlyMap<string, Set<string>>;
  /** 過去 28 日ぶんの掲載記事（タイムライン用） */
  publishedByTopic: ReadonlyMap<string, IndexEntry[]>;
  /** 今日プールに出たが掲載しなかった記事（話題キーごと・スコア降順） */
  unplacedByTopic: ReadonlyMap<string, RawItem[]>;
}

/** 台帳から盤面を組む */
export function buildBoard(input: BuildBoardInput): TrendBoard {
  const { date, updatedAt, days, labels } = input;
  const keys = new Set<string>();
  for (const day of days) for (const key of Object.keys(day.counts)) keys.add(key);

  const profiles: Profile[] = [];
  for (const key of keys) {
    const profile = profileOf(key, days, date);
    if (profile) profiles.push(profile);
  }

  const folded = foldDuplicates(profiles, labels);
  const aliases = folded.aliases;
  profiles.length = 0;
  profiles.push(...folded.profiles);

  const warmingUp = days.length < MIN_HISTORY_DAYS;

  /*
   * 背景（常在）は一覧から外すのではなく、外したことを見せるために持つ。
   * 判定の主軸は水準（share）なので、毎日出ているだけの語は平常比が 1.0 前後に
   * なり、hot にも keep にも自然に入らない。
   */
  const background = profiles
    .filter((p) => p.presence >= BACKGROUND_PRESENCE)
    .sort((a, b) => b.total - a.total);

  /*
   * 立ち上げ中は平常比が出せない（比べる過去が無い）。全部を「初出」として
   * NEW を付けると嘘になるので、その間は当日の本数順に出すだけにする。
   */
  const hot = warmingUp
    ? profiles
        .filter((p) => p.today >= HOT_MIN_TODAY)
        .sort((a, b) => b.today - a.today)
        .slice(0, MAX_HOT)
    : profiles
        .filter((p) => p.today >= HOT_MIN_TODAY && (p.lift == null || p.lift >= HOT_MIN_LIFT))
        // 規模（本数）× 異常さ（平常比）。極端な平常比が独占しないよう頭を打つ
        .sort((a, b) => b.today * Math.min(b.lift ?? 10, 10) - a.today * Math.min(a.lift ?? 10, 10))
        .slice(0, MAX_HOT);

  const hotKeys = new Set(hot.map((p) => p.key));
  /*
   * 背景語を presence（出現日数）で外してはいけない。母集団 572 件では `Cursor`
   * のような話題も毎日 1〜2 本は出るので、presence で切ると**追いたいものが
   * まず落ちる**。毎日出ていること自体は無情報で、続いているかは水準で測る。
   * 絞りはしきい値（KEEP_MIN_LIFT）だけに任せる。
   */
  const keep = warmingUp
    ? []
    : profiles
        .filter(
          (p) =>
            !hotKeys.has(p.key) &&
            p.last3Count > 0 &&
            p.recentCount >= KEEP_MIN_RECENT &&
            (p.liftRecent == null || p.liftRecent >= KEEP_MIN_LIFT),
        )
        .sort((a, b) => b.recentCount - a.recentCount)
        .slice(0, MAX_KEEP);

  const cool = warmingUp
    ? []
    : profiles
        .filter(
          (p) =>
            !hotKeys.has(p.key) &&
            p.beforeCount >= COOL_MIN_BEFORE &&
            p.remaining != null &&
            p.remaining <= COOL_MAX_REMAINING,
        )
        .sort((a, b) => b.beforeCount - a.beforeCount)
        .slice(0, MAX_COOL);

  const toTopic = (p: Profile, state: TrendState): TrendTopic => {
    const name = labels.get(p.key) ?? p.key;
    // 畳んだ別名も変種として出す（`DeepSeek Harness · DSH`）
    const variants = [
      ...(aliases.get(p.key) ?? []),
      ...[...(input.variantsByTopic.get(p.key) ?? [])].filter((v) => meaningfulVariant(v, name)),
    ].slice(0, 3);
    return {
      key: p.key,
      name,
      variants,
      state,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      total: p.total,
      today: p.today,
      lift: p.lift,
      liftRecent: p.liftRecent,
      recentCount: p.recentCount,
      activeDays7: p.activeDays7,
      history: p.history,
      articles: buildTimeline(
        p.key,
        input.publishedByTopic,
        state === 'cool' ? [] : (input.unplacedByTopic.get(p.key) ?? []),
      ),
    };
  };

  const shown = new Set([...hot, ...keep, ...cool].map((p) => p.key));

  const notes: string[] = [];
  if (warmingUp) {
    notes.push(
      `話題の集計を始めたばかりです（${days.length} 日ぶん）。` +
        `平常より動いているかの判定には ${MIN_HISTORY_DAYS} 日ぶんの履歴が必要なので、` +
        'いまは当日よく出ている話題を本数順に並べています。' +
        `あと ${MIN_HISTORY_DAYS - days.length} 日で「急上昇」「追跡中」「落ち着いた」が出ます。`,
    );
  }

  return {
    updatedAt,
    date,
    ledgerDays: days.length,
    windowDays: SPARK_DAYS,
    warmingUp,
    hot: hot.map((p) => toTopic(p, 'hot')),
    keep: keep.map((p) => toTopic(p, 'keep')),
    cool: cool.map((p) => toTopic(p, 'cool')),
    /*
     * 背景は「外したもの」の一覧なので、実際に外さなかったものは載せない。
     * 同じ語が「今日動いた」と「背景」に並ぶと、読者にはただの矛盾に見える。
     */
    ubiquitous: background
      .filter((p) => !shown.has(p.key))
      .slice(0, MAX_UBIQUITOUS)
      .map((p) => labels.get(p.key) ?? p.key),
    notes,
  };
}

/**
 * 掲載記事を話題ごとに割り当てる。
 *
 * タイムラインは掲載済みの記事から組む。「8/18 に知る 1 位で出した」と
 * 見えることで、この画面が読み直しではなく**自分が見た地点からの差分確認**に
 * なる。トレンド画面が死ぬ一番の理由は既読の再掲なので、ここが要点。
 */
export function assignPublished(
  entries: readonly IndexEntry[],
  vocab: Vocabulary,
): Map<string, IndexEntry[]> {
  const byTopic = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    for (const key of matchTopics(entryHaystack(entry), vocab)) {
      const list = byTopic.get(key) ?? [];
      list.push(entry);
      byTopic.set(key, list);
    }
  }
  for (const list of byTopic.values()) list.sort((a, b) => (a.date < b.date ? 1 : -1));
  return byTopic;
}

/** 今日プールに出たが掲載しなかった記事を、話題ごとにスコア降順で持つ */
export function collectUnplaced(
  itemsByTopic: ReadonlyMap<string, PreScoredItem[]>,
  publishedUrls: ReadonlySet<string>,
  normalize: (url: string) => string,
): Map<string, RawItem[]> {
  const result = new Map<string, RawItem[]>();
  for (const [key, items] of itemsByTopic) {
    const unplaced = items
      .filter((item) => !publishedUrls.has(normalize(item.url)))
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, MAX_UNPLACED_TODAY);
    if (unplaced.length > 0) result.set(key, unplaced);
  }
  return result;
}

/** 台帳の全期間で使われている表示名を集める（シャードへ書き戻す用） */
export function labelsForLedger(
  days: readonly TrendDay[],
  labels: ReadonlyMap<string, string>,
  previous: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = new Set<string>();
  for (const day of days) for (const key of Object.keys(day.counts)) keys.add(key);
  for (const key of keys) {
    const label = labels.get(key) ?? previous[key];
    if (label) out[key] = label;
  }
  return out;
}
