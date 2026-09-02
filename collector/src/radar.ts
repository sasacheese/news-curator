import type { LlmBackend } from './backend.js';
import type { RuntimeConfig } from './config.js';
import { complete } from './llm.js';
import type { RadarPitchResult, RadarResolveResult } from './schemas.js';
import { RadarPitchSchema, RadarResolveSchema } from './schemas.js';
import { buildTryPrompt, radarQuestions } from './try-prompt.js';
import type {
  IndexEntry,
  RadarBoard,
  RadarItem,
  RadarLedgerEntry,
  RadarMeasure,
  RadarVerdict,
  RawItem,
  TopicsConfig,
} from './types.js';
import { RADAR_VERDICTS } from './types.js';
import { fetchJson, fetchWithRetry, hashId, log, mapLimit, safe, truncate } from './util.js';

/* ------------------------------------------------------------------ *
 * 発掘
 *
 * 目的は 1 つ。「このライブラリ知ってます？あんまり話題じゃないけど便利で」
 * 「これ海外では話題だけど日本ではまだ誰も使ってない」を、**根拠つきで**
 * 人に言える状態にすること。
 *
 * だから設計上の要点は「面白い道具を探すこと」ではない。面白い道具は
 * 作るレーンが既に毎日出している。足りないのは**まだ広まっていないことの証明**で、
 * それが無いと人に言えない（言った先で「それもう使ってますよ」が返ってくる）。
 *
 * 証明の作り方は 2 つの物差しの差を測ること。
 *
 *   海外の熱   npm の週間ダウンロード数 / GitHub のスター / 英語圏での言及回数
 *   国内の厚み Qiita の記事数 / Zenn の記事数 / 日本語での言及回数
 *
 * ここで LLM に判定させないことが決定的に重要。「これは海外で話題ですか」と
 * 聞けば必ず答えは返ってくるが、それは学習時点の記憶であって現在の観測ではない。
 * 数えるのはこちらの仕事で、LLM に任せるのは名前の同定と紹介文だけにしている。
 * ------------------------------------------------------------------ */

export interface RadarConfig {
  enabled: boolean;
  /** これ以下の記事数なら「日本語ではまだ薄い」 */
  domesticThin: number;
  /** これを超えたら「もう知られている」として落とす */
  domesticKnown: number;
  /** 1 回の実行で外部 API を叩く語の数 */
  measureBudget: number;
  /** 同じ語を再計測しない日数 */
  remeasureAfterDays: number;
  /** 候補に入るのに必要な、過去 90 日での出現回数 */
  minMentions: number;
  /** 「実際に使われている」と見なすしきい値 */
  adoption: { npmWeekly: number; stars: number };
  limits: Record<RadarVerdict, number>;
  /** 候補から常に外す語（完全一致・大文字小文字は無視） */
  exclude: string[];
}

/**
 * 過去のダイジェストを何日ぶん遡って言及を数えるか。
 *
 * 候補の母集団を読む側（index.ts / radar-dry.ts）も同じ日数を渡す必要があるので
 * 公開している。ここと呼び出し側がずれると、根拠の文の「直近 90 日で」だけが
 * 実際に読んだ範囲と食い違う。
 */
export const MENTION_WINDOW_DAYS = 90;

/**
 * 勢いがあると見なす下限。
 *
 * early（海外で先行）と hidden（静かに使われている）はこの値だけで分かれる。
 * 分ける理由は、読者が言う台詞が違うから——「今話題になってる」と言うには
 * 勢いの観測が要るが、「知られてないけど使われてる」には要らない。
 */
const MOMENTUM_HOT = 0.45;

/** 台帳から落とすまでの日数。道具でなかった語をいつまでも持たない */
const LEDGER_TTL_DAYS = 180;

/* ------------------------------------------------------------------ *
 * 語の正規化
 * ------------------------------------------------------------------ */

/** 台帳のキー。表記揺れ（oxlint / Oxlint / OXLINT）を 1 つにまとめる */
export function radarKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 名前から末尾のバージョンを落とす。
 *
 * keywords には「Next.js 16.3」「Dify 1.x」のようにバージョン付きで入ることがある。
 * そのままだと同じ道具がバージョンごとに別の語として台帳に増え、しかも除外リスト
 * （「Next.js」）にも当たらないので、既知のものが毎回候補に上がり続ける。
 *
 * 落とすのは**末尾の裸のバージョンだけ**。「Gemini 3.6 Flash」のように数字が
 * 名前の一部で末尾に無いものは触らない（モデル名は世代が名前の一部なので、
 * 落とすと別物になる）。
 */
export function stripVersion(name: string): string {
  const stripped = name.trim().replace(/\s+v?\d+(\.\d+)*(\.x)?$/i, '');
  return stripped.length >= 2 ? stripped : name.trim();
}

/** Qiita のタグ・Zenn のトピックに使うスラッグ */
export function tagSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[@/.]/g, '');
}

/**
 * 道具の名前になりうる形か。
 *
 * 計測は 1 語あたり最大 4 リクエストかかるので、明らかに道具でないものは
 * LLM に渡す前にここで落とす。**ここで落とすのは「形」だけ**——意味の判定
 * （概念か道具か）は LLM の仕事で、こちらでやろうとすると必ず取りこぼす。
 */
const FUNCTION_WORDS = new Set([
  'to', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'and', 'or', 'from',
  'your', 'my', 'how', 'why', 'what', 'is', 'are', 'be', 'using', 'via',
]);

export function isPlausibleToolName(name: string): boolean {
  const n = name.trim();
  if (n.length < 2 || n.length > 40) return false;
  // 設定ファイル名・ドキュメント名。実測で CLAUDE.md / settings.json / SKILL.md が来る
  if (/\.(md|json|ya?ml|toml|ts|tsx|js|env|lock)$/i.test(n)) return false;
  // バージョン番号・日付・CVE 番号だけのもの
  if (/^v?\d+(\.\d+)*$/.test(n)) return false;
  if (/^(cve|ghsa)-/i.test(n)) return false;
  if (/^\d{4}-\d{2}/.test(n)) return false;
  // URL とパス
  if (/^https?:|^\//.test(n)) return false;
  // 4 語以上は道具の名前ではなく説明文
  const words = n.split(/\s+/);
  if (words.length > 3) return false;
  /*
   * 大文字だけの短い略語。実測で SSR / CLI / DSL / PPTX / YAML / DSH が来ていた。
   * これらは技術用語であって、探して紹介する対象になる道具ではない。
   * 小文字の短い名前（uv, ky）は本物の道具なので、大文字限定にしている。
   */
  if (/^[A-Z]{2,5}$/.test(n)) return false;
  /*
   * 記事のタイトルの断片。keywords には「Migrating to V9」のような句が混ざる。
   * 英語の機能語を含む複数語は、道具の名前ではなく文の一部と見て落とす。
   */
  if (words.length > 1 && words.some((w) => FUNCTION_WORDS.has(w.toLowerCase()))) return false;
  // ひらがな・カタカナを含む語はほぼ一般名詞（「エージェント」「サブエージェント」）。
  // 道具名にカタカナが入ることはまず無いので、ここは形で切れる
  if (/[ぁ-んァ-ヶー]/.test(n)) return false;
  // 英数字を 1 文字も含まないもの（漢字だけの一般語）
  if (!/[a-z0-9]/i.test(n)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 1) 候補の抽出
 *
 * 新しい収集はしない。過去のダイジェストの keywords（LLM が固有名詞優先で
 * 抽出済み）と、当日の GitHub リポジトリだけを母集団にする。
 * ------------------------------------------------------------------ */

export interface RadarCandidate {
  name: string;
  /** 英語の記事で見かけた回数 */
  abroad: number;
  /** 日本語の記事で見かけた回数 */
  domestic: number;
  /** どの記事から見つけたか（最新のもの） */
  via: { title: string; url: string } | null;
  /** GitHub 由来なら owner/repo が既に分かっている */
  repoHint: string | null;
}

/**
 * 計測の優先順位。
 *
 * 予算（measureBudget）を超える候補は今日測らないので、順番がそのまま
 * 「何を先に見つけるか」になる。英語圏で繰り返し見かけていて、日本語では
 * 見かけないものを上に置く——それがこの機能の狙いそのものだからだ。
 */
export function candidatePriority(c: RadarCandidate): number {
  return c.abroad * 3 - c.domestic + (c.repoHint ? 2 : 0);
}

export function collectCandidates(
  entries: readonly IndexEntry[],
  items: readonly RawItem[],
  cfg: RadarConfig,
  topics?: TopicsConfig,
): RadarCandidate[] {
  /*
   * 除外は 2 つの出どころを合わせる。
   *
   * radar.json の exclude は手で管理するもので、topics.json のキーワードは
   * **定義上その読者が既に知っているもの**（自分で書いた関心リストなので）。
   * 後者を自動で外しておかないと、設定画面でトピックを増やすたびに
   * 既知の道具が候補へ戻ってくる。
   *
   * 突き合わせは完全一致にとどめる。部分一致にすると「agent」で AgentKit まで
   * 消えるので、除外が候補の入口を塞いでしまう。
   */
  const excluded = new Set([
    ...cfg.exclude.map(radarKey),
    ...(topics?.topics ?? []).flatMap((t) => [radarKey(t.name), ...t.keywords.map(radarKey)]),
  ]);
  const found = new Map<string, RadarCandidate>();

  const touch = (raw: string, via: RadarCandidate['via'], repoHint: string | null) => {
    const name = stripVersion(raw);
    const key = radarKey(name);
    if (excluded.has(key) || !isPlausibleToolName(name)) return null;
    const existing = found.get(key);
    if (existing) {
      // 表記は最初に見たものを残す。via は呼び出し側が新しい順に渡す
      if (!existing.repoHint && repoHint) existing.repoHint = repoHint;
      return existing;
    }
    const fresh: RadarCandidate = { name, abroad: 0, domestic: 0, via, repoHint };
    found.set(key, fresh);
    return fresh;
  };

  // 新しい順に見る。同じ語を複数の記事で見たとき、via は最新のものが残る
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  for (const entry of sorted) {
    for (const keyword of entry.keywords ?? []) {
      const c = touch(keyword, { title: entry.title, url: entry.url }, null);
      if (!c) continue;
      if (entry.lang === 'ja') c.domestic++;
      else if (entry.lang === 'en') c.abroad++;
    }
  }

  /*
   * 当日の GitHub リポジトリ。
   *
   * ここが「まだ誰の語彙にも無い道具」の唯一の入口になる。過去のダイジェストの
   * keywords は、一度は掲載された記事から来ているので、掲載に至らなかった
   * リポジトリは含まれない。名前解決も要らない（owner/repo が分かっている）。
   */
  for (const item of items) {
    if (item.source !== 'github_repo') continue;
    const repo = parseRepo(item.url);
    if (!repo) continue;
    // owner/repo の repo 側だけを名前にする。owner は道具の名前ではない
    const c = touch(repo.split('/')[1] ?? '', { title: item.title, url: item.url }, repo);
    if (c) c.abroad++;
  }

  return [...found.values()]
    .filter((c) => c.repoHint != null || c.abroad + c.domestic >= cfg.minMentions)
    .sort((a, b) => candidatePriority(b) - candidatePriority(a));
}

/**
 * GitHub の URL から owner/repo を取り出す。
 * npm の repository.url は `git+https://github.com/owner/repo.git` の形も来る。
 */
function parseRepo(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/* ------------------------------------------------------------------ *
 * 2) 計測
 *
 * すべて「測れなかった」と「0 だった」を区別する。null を 0 に丸めると
 * 「Qiita に 1 本も無い」という**存在しない発見**を報告してしまう。
 * この機能では、それが人に伝わってしまう分だけ他の欠陥より重い。
 * ------------------------------------------------------------------ */

/**
 * Qiita でこの道具に言及している記事数。
 *
 * 既定はフレーズ検索。「その道具について書かれた記事」より広く
 * 「その道具の名前が出てくる記事」を数える——狙いは「日本でどれだけ
 * 知られているか」なので、専用記事だけを数えると過小になり、
 * 「まだ誰も知らない」と誤って言ってしまう。
 *
 * ただし名前が英語の一般語と同じ綴りのときはフレーズ検索が使えない
 * （実測: Effect は 12,342 件で、ほぼ全部が CSS のアニメーションの記事）。
 * その場合だけタグ検索に切り替える。タグは完全一致なので誤検出が無い。
 */
async function measureQiita(
  name: string,
  commonWord: boolean,
): Promise<{ count: number | null; method: RadarMeasure['qiitaMethod'] }> {
  const method = commonWord ? 'tag' : 'mention';
  const query = commonWord ? `tag:${tagSlug(name)}` : `"${name}"`;
  const token = process.env.QIITA_TOKEN;
  const res = await fetchWithRetry(
    `https://qiita.com/api/v2/items?query=${encodeURIComponent(query)}&per_page=1`,
    {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      retries: 1,
    },
  );
  if (!res.ok) throw new Error(`qiita ${name} -> HTTP ${res.status}`);
  // 件数はボディではなくヘッダに入る。1 件だけ取って総数を読む
  const total = res.headers.get('total-count');
  if (total == null) throw new Error(`qiita ${name} -> total-count ヘッダが無い`);
  const n = Number(total);
  return { count: Number.isFinite(n) ? n : null, method };
}

/**
 * Zenn の記事数。
 *
 * トピック（タグ）の記事数が取れればそれを使う——正確な総数が 1 リクエストで返る。
 * 複数語の名前にはトピックが存在しないので（「TanStack Router」は該当なし）、
 * そのときだけ検索に落とす。検索は 1 ページで打ち切られるため**下限値**でしかなく、
 * 意味が違う数字なので method に記録して画面でも区別する。
 */
/** Zenn の検索は 1 ページ 48 件。続きがあるかは next_page で分かる */
const ZENN_SEARCH_PAGE = 48;

async function measureZenn(
  name: string,
): Promise<{ count: number | null; method: RadarMeasure['zennMethod']; complete: boolean | null }> {
  const topic = await safe(
    `zenn topic ${name}`,
    async () => {
      const res = await fetchWithRetry(`https://zenn.dev/api/topics/${tagSlug(name)}`, {
        retries: 1,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { topic?: { taggings_count?: number } };
      const n = body.topic?.taggings_count;
      return typeof n === 'number' ? n : null;
    },
    null,
  );
  // トピックの記事数は総数そのものなので、常に確定している
  if (topic != null) return { count: topic, method: 'topic', complete: true };

  const searched = await safe(
    `zenn search ${name}`,
    async () => {
      const body = await fetchJson<{ articles?: unknown[]; next_page?: unknown }>(
        `https://zenn.dev/api/search?q=${encodeURIComponent(name)}&source=articles`,
        { retries: 1 },
      );
      if (!Array.isArray(body.articles)) return null;
      /*
       * next_page が無ければ、その件数は総数として確定している。実測で
       * 「TanStack Router」は 31 件で next_page なし（= ちょうど 31 本）、
       * 「React」は 48 件で next_page あり（= 48 本以上）だった。
       * 確定しているかどうかで、この数字を「薄い」の根拠に使えるかが変わる。
       */
      return {
        count: body.articles.length,
        complete: body.next_page == null && body.articles.length < ZENN_SEARCH_PAGE,
      };
    },
    null,
  );
  if (!searched) return { count: null, method: null, complete: null };
  return { count: searched.count, method: 'search', complete: searched.complete };
}

/**
 * npm の週間ダウンロード数と伸び率。
 *
 * ダウンロード数は、この機能で唯一「話題ではなく実際に使われている量」を
 * 測れる指標。スターは読んだ人が押すが、ダウンロードは動かした人しか発生させない。
 *
 * 伸び率は last-month の日別から自分で出す。履歴を貯めなくても初日から
 * 勢いが取れるので、台帳が空の状態でも early と hidden を分けられる。
 */
interface NpmFacts {
  /** レジストリが返した正式なパッケージ名。実在しなければ null */
  name: string | null;
  version: string | null;
  deprecated: boolean | null;
  /** package.json の repository から導いた owner/repo */
  repo: string | null;
}

/**
 * パッケージが実在するかを確かめ、公開されている事実を取る。
 *
 * **この確認を入れる理由。** 名前解決を LLM に任せている以上、存在しない
 * パッケージ名が返ることがある（実測で「TanStack Table」に `@tanstack/table` が
 * 割り当てられ、404 だった）。確認せずに進むと、ダウンロード数だけが欠測した
 * 状態でカードが出て、npm への死んだリンクが並ぶ。名前が間違っていることを
 * **欠測として黙らせない**のがここの仕事。
 *
 * repository は maintainer が公開した値なので、LLM の推測より確かな出どころになる。
 */
async function fetchNpmFacts(pkg: string): Promise<NpmFacts> {
  const res = await fetchWithRetry(
    `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
    { headers: { accept: 'application/json' }, retries: 1 },
  );
  if (res.status === 404) return { name: null, version: null, deprecated: null, repo: null };
  if (!res.ok) throw new Error(`npm registry ${pkg} -> HTTP ${res.status}`);
  const body = (await res.json()) as {
    name?: string;
    version?: string;
    deprecated?: unknown;
    repository?: { url?: string } | string;
  };
  const rawRepo = typeof body.repository === 'string' ? body.repository : body.repository?.url;
  return {
    name: body.name ?? pkg,
    version: body.version ?? null,
    deprecated: body.deprecated != null && body.deprecated !== false,
    repo: parseRepo(rawRepo ?? ''),
  };
}

async function measureNpm(pkg: string): Promise<{ weekly: number | null; trend: number | null }> {
  const range = await safe(
    `npm range ${pkg}`,
    async () => {
      const body = await fetchJson<{ downloads?: { downloads: number }[] }>(
        `https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(pkg)}`,
        { retries: 1 },
      );
      return body.downloads ?? null;
    },
    null,
  );
  if (!range || range.length < 14) {
    // 範囲が取れないときは週次だけでも取る（新しいパッケージは月次が短い）
    const point = await safe(
      `npm point ${pkg}`,
      async () => {
        const body = await fetchJson<{ downloads?: number }>(
          `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`,
          { retries: 1 },
        );
        return typeof body.downloads === 'number' ? body.downloads : null;
      },
      null,
    );
    return { weekly: point, trend: null };
  }

  const sum = (xs: { downloads: number }[]) => xs.reduce((t, x) => t + x.downloads, 0);
  const last7 = sum(range.slice(-7));
  const prev7 = sum(range.slice(-14, -7));
  return { weekly: last7, trend: prev7 > 0 ? Math.round((last7 / prev7) * 100) / 100 : null };
}

async function measureGithub(
  repo: string,
): Promise<{ stars: number | null; pushedAt: string | null; archived: boolean | null }> {
  const token = process.env.GITHUB_TOKEN;
  const body = await fetchJson<{
    stargazers_count?: number;
    pushed_at?: string;
    archived?: boolean;
  }>(`https://api.github.com/repos/${repo}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    retries: 1,
  });
  return {
    stars: typeof body.stargazers_count === 'number' ? body.stargazers_count : null,
    pushedAt: body.pushed_at ?? null,
    archived: typeof body.archived === 'boolean' ? body.archived : null,
  };
}

/**
 * ダウンロード数がスター数を下回っていないか。
 *
 * 下回っていたら、測っているパッケージが道具の本体ではない疑いが強い。
 * スターは 1 人 1 回しか増えないのに対しダウンロードは使うたびに増えるので、
 * 実際に使われているライブラリでは必ずダウンロードが上回る。
 *
 * スター数の下限を置いているのは、まだ小さい道具では母数が小さすぎて
 * この比が意味を持たないため（100★ / 週 80 DL はありうる）。
 */
export function looksLikeWrongPackage(
  npmWeekly: number | null,
  githubStars: number | null,
): boolean {
  if (npmWeekly == null || githubStars == null) return false;
  if (githubStars < 3000) return false;
  return npmWeekly < githubStars;
}

/**
 * 1 つの道具を測る。どれか 1 つが落ちても他は残す。
 *
 * npm を先に確かめてから GitHub を見る。レジストリの repository が
 * LLM の推測より確かな出どころなので、リポジトリが分からない道具は
 * ここで拾える。
 */
export interface MeasureOutcome {
  measure: RadarMeasure;
  /**
   * 名前解決の npm パッケージ名が実在しなかった。台帳から消して、
   * 翌日また同じ 404 を取りに行かないようにする。
   */
  clearNpmPackage: boolean;
}

export async function measureTool(entry: RadarLedgerEntry, now: Date): Promise<MeasureOutcome> {
  const resolved = entry.resolved;
  /*
   * 国内の記事数は**人が記事に書くときの名前**で数える。台帳のキーは
   * 「@tanstack/table-core」のようにパッケージ名で入ってくることがあり、
   * それで Qiita を引くと 1 本しか出ない（記事には「TanStack Table」と書かれる）。
   * 実測でこの取り違えが起き、36 本あるものを 1 本として報告していた。
   */
  const name = resolved?.displayName || entry.name;

  const [qiita, zenn, npm] = await Promise.all([
    safe(`qiita ${name}`, () => measureQiita(name, resolved?.nameIsCommonWord ?? true), {
      count: null,
      method: null as RadarMeasure['qiitaMethod'],
    }),
    measureZenn(name),
    resolved?.npmPackage
      ? safe(
          `npm ${name}`,
          async () => {
            const pkg = resolved.npmPackage as string;
            const facts = await fetchNpmFacts(pkg);
            if (!facts.name) {
              /*
               * 実在しないパッケージ名。名前を null に落として、リンクも数字も
               * 出さない。ここで名前を残すと、npm の 404 ページへのリンクが
               * カードに並び、しかも「ダウンロード数は測れなかった」だけの顔をする。
               */
              log.warn(`  ${name}: npm に ${pkg} は存在しません（名前解決の誤り）`);
              return { facts, weekly: null, trend: null, clearPackage: true };
            }
            const stats = await measureNpm(facts.name);
            return { facts, ...stats, clearPackage: false };
          },
          {
            facts: { name: null, version: null, deprecated: null, repo: null },
            weekly: null,
            trend: null,
            clearPackage: false,
          },
        )
      : Promise.resolve({
          facts: { name: null, version: null, deprecated: null, repo: null } as NpmFacts,
          weekly: null,
          trend: null,
          clearPackage: false,
        }),
  ]);

  /*
   * リポジトリの出どころの優先順位。
   * 名前解決の結果（観測できた repoHint か LLM の推測）を優先し、
   * 無いときだけレジストリから補う。両者が食い違うときは、npm パッケージ名の
   * 取り違えを疑う手がかりになるので警告に出す。
   */
  const repo = resolved?.githubRepo ?? npm.facts.repo;
  if (resolved?.githubRepo && npm.facts.repo && resolved.githubRepo.toLowerCase() !== npm.facts.repo.toLowerCase()) {
    log.warn(
      `  ${name}: リポジトリが食い違っています（解決 ${resolved.githubRepo} / npm ${npm.facts.repo}）。` +
        'npm パッケージ名の取り違えの可能性があります',
    );
  }

  const github = repo
    ? await safe(`github ${name}`, () => measureGithub(repo), {
        stars: null,
        pushedAt: null,
        archived: null,
      })
    : { stars: null, pushedAt: null, archived: null };

  /*
   * 「実在するが別のパッケージ」を検出する。
   *
   * 実在確認は 404 しか防げない。実測で「TanStack Router」に `@tanstack/router` が
   * 割り当てられたが、それは 0.0.1-beta.53 で止まった別物だった（本体は
   * @tanstack/react-router）。名前は実在するので存在確認では通ってしまう。
   *
   * 手がかりはダウンロード数とスター数の比。スターは 1 人 1 回しか増えないが、
   * ダウンロードは使うたびに増えるので、実際に使われているライブラリでは
   * ダウンロードがスターを 1 桁以上上回る。下回っているならパッケージ名の
   * 取り違えを疑うべきで、**信用できない数字は出さない**（欠測として扱う）。
   *
   * 実測での確認: unplugin 3,605★/5,118万DL、Oxlint 22,367★/1,355万DL、
   * Turso 17,145★/175万DL はいずれも通り、@tanstack/router 14,964★/5,390DL だけが落ちる。
   */
  const npmLooksMismatched =
    npm.facts.name != null && looksLikeWrongPackage(npm.weekly, github.stars);
  if (npmLooksMismatched) {
    log.warn(
      `  ${name}: npm の ${npm.facts.name} は週 ${npm.weekly} ダウンロードで、` +
        `スター ${github.stars} を下回ります。別のパッケージを指している可能性が高いため、` +
        'npm の計測値を捨てます',
    );
  }

  const measure: RadarMeasure = {
    githubRepo: repo,
    githubStars: github.stars,
    githubPushedAt: github.pushedAt,
    githubArchived: github.archived,
    npmPackage: npmLooksMismatched ? null : npm.facts.name,
    npmVersion: npmLooksMismatched ? null : npm.facts.version,
    // 非推奨の判定だけは残す。取り違えていても「非推奨のものを勧めない」側に働く
    npmDeprecated: npm.facts.deprecated,
    npmWeekly: npmLooksMismatched ? null : npm.weekly,
    npmTrend: npmLooksMismatched ? null : npm.trend,
    abroadMentions: entry.mentions.abroad,
    qiitaArticles: qiita.count,
    qiitaMethod: qiita.method,
    zennArticles: zenn.count,
    zennMethod: zenn.method,
    zennComplete: zenn.complete,
    domesticMentions: entry.mentions.domestic,
    measuredAt: now.toISOString(),
  };
  return { measure, clearNpmPackage: npm.clearPackage };
}

/* ------------------------------------------------------------------ *
 * 3) 判定
 *
 * ここは全部純関数にしてテストで固定する。しきい値を動かしたときに
 * 何が出て何が落ちるかを、実行しないと分からない状態にしたくない。
 * ------------------------------------------------------------------ */

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 0 のとき 0、half で 0.5、増えるほど 1 に近づく */
function saturate(n: number, half: number): number {
  return n <= 0 ? 0 : n / (n + half);
}

/** lo で 0、hi で 1 の対数スケール。桁で動く量（DL 数・スター数）に使う */
function logScale(v: number, lo: number, hi: number): number {
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  return Math.log(v / lo) / Math.log(hi / lo);
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 86_400_000;
}

/**
 * 国内の厚み。Qiita と Zenn の記事数の合計。
 *
 * **片方でも欠測なら null を返す。** 以前は取れたほうだけを使い、
 * 「下限側に振れるだけだから実測として使える」と考えていたが、それは逆だった。
 * この数字で行う主張は「日本語ではまだ薄い」——**上限の主張**なので、
 * 下限側に振れる数字では言えない。
 *
 * 実際に壊れた: Qiita がレート上限（未認証は 60 リクエスト/時）で 403 を返した
 * 実行で、TanStack Table が「日本語の記事は 0 本」として盤面に載った。
 * 本当は 36 本ある。この状態で人に紹介すると、その場で否定される。
 *
 * Zenn 側の「数え切れなかった」（検索が 1 ページに収まらない）も同じ理由で
 * judge が落とす。欠測は 0 ではないし、下限値は上限ではない。
 */
export function domesticThickness(m: RadarMeasure): number | null {
  if (m.qiitaArticles == null || m.zennArticles == null) return null;
  return m.qiitaArticles + m.zennArticles;
}

/**
 * 実際に使われている量。0〜1。
 *
 * npm の週間 DL とスター数の**大きいほう**を採る。npm に無い道具（Rust の CLI、
 * エディタ拡張）はスターしか手がかりが無く、逆にスターが伸びないまま
 * 大量に使われている道具（unplugin は 3,605★ で週 5,100 万 DL）もある。
 * どちらか片方でも十分な証拠になる。
 */
export function adoptionStrength(m: RadarMeasure): number {
  const dl = m.npmWeekly == null ? 0 : logScale(m.npmWeekly, 1_000, 5_000_000);
  const stars = m.githubStars == null ? 0 : logScale(m.githubStars, 300, 20_000);
  return Math.max(dl, stars);
}

/**
 * 勢い。0〜1。
 *
 * 「今話題になっている」と言うために必要な観測。伸び率だけに頼らないのは、
 * 週次のダウンロード数が曜日と連休で ±15% ほど動くから（実測で、安定して
 * 使われている Hono も 0.86 倍の週があった）。1.15 倍を超えたぶんだけを
 * 勢いとして数え、残りは自分のダイジェストでの出現回数と更新の新しさで補う。
 */
export function momentum(m: RadarMeasure, now: Date): number {
  const trend = m.npmTrend == null ? 0 : clamp01((m.npmTrend - 1.15) / 0.35);
  const mentions = saturate(m.abroadMentions, 2);
  const fresh = m.githubPushedAt ? clamp01(1 - daysSince(m.githubPushedAt, now) / 30) : 0;
  return clamp01(trend * 0.4 + mentions * 0.4 + fresh * 0.2);
}

export interface RadarJudgement {
  verdict: RadarVerdict | null;
  /** 落とした理由。しきい値を調整するために台帳へ残す */
  reason: string | null;
  score: number;
}

/**
 * 発掘の枠に入るかを決める。
 *
 * 落とす条件を先に全部通す。「該当なし」を素直に返せることがこの機能の
 * 前提で、枠を埋めるために基準を下げると、紹介した相手に「それ普通に
 * 使われてますよ」と返される——それが起きた時点でこの機能の価値は 0 になる。
 */
export function judge(
  m: RadarMeasure,
  cfg: RadarConfig,
  opts: { now: Date; affinity: number },
): RadarJudgement {
  const reject = (reason: string): RadarJudgement => ({ verdict: null, reason, score: 0 });

  if (m.githubArchived) return reject('リポジトリがアーカイブ済み');
  if (m.npmDeprecated) return reject('npm で非推奨として公開されている');

  /*
   * 「日本語ではまだ薄い」は**上限の主張**なので、上から抑えられない数字では
   * 言えない。Zenn の検索が 1 ページに収まらなかったときがそれに当たる
   * （48 件までしか数えられず、実際は 1,000 本あるかもしれない）。
   * ここを通すと、よく知られた道具を「まだ誰も書いていない」として出してしまう。
   */
  if (m.zennComplete === false) return reject('国内の記事数を数え切れなかった（48 本以上）');

  const domestic = domesticThickness(m);
  if (domestic == null) {
    // どちらが欠けたのかを残す。Qiita のレート上限は運用で必ず当たるので区別が要る
    const missing = [
      m.qiitaArticles == null ? 'Qiita' : null,
      m.zennArticles == null ? 'Zenn' : null,
    ].filter(Boolean);
    return reject(`国内の記事数を測れなかった（${missing.join(' / ')}）`);
  }
  if (domestic > cfg.domesticKnown) {
    return reject(`日本語の記事が ${domestic} 本あり、日本でも既に知られている`);
  }
  if (domestic > cfg.domesticThin) {
    return reject(`日本語の記事が ${domestic} 本で、「まだ薄い」とは言えない`);
  }

  const adopted =
    (m.npmWeekly ?? 0) >= cfg.adoption.npmWeekly || (m.githubStars ?? 0) >= cfg.adoption.stars;
  const mo = momentum(m, opts.now);
  if (!adopted && mo < MOMENTUM_HOT) {
    return reject('実際に使われている証拠も、勢いの証拠も無い');
  }

  /*
   * 勢いがあれば early、無ければ hidden。順番に意味がある——勢いのある
   * ものを hidden に入れると「知られてないけど便利」という台詞にならない
   * （今まさに話題になっているものは、そう遠くないうちに知られる）。
   */
  const verdict: RadarVerdict = mo >= MOMENTUM_HOT ? 'early' : 'hidden';

  /*
   * 紹介価値の順位づけ。薄さと実力を半々で見て、自分の関心に近いものを少し上げる。
   * 関心を主軸にしないのは、この枠の値打ちが「自分の関心の外にある良い道具」に
   * あるからで、そこを門番にすると既に知っている領域しか出てこなくなる。
   */
  const thinness = clamp01(1 - domestic / Math.max(1, cfg.domesticThin));
  const strength = Math.max(adoptionStrength(m), mo);
  const score = Math.round(
    100 * clamp01(thinness * 0.4 + strength * 0.45 + clamp01(opts.affinity) * 0.15),
  );

  return { verdict, reason: null, score };
}

/* ------------------------------------------------------------------ *
 * 4) 根拠の文
 *
 * **生成しない。** 計測値からそのまま組み立てる。数字を LLM に書かせると
 * 必ず実際の計測値とずれ、そのずれた数字を持って人に話しに行くことになる。
 * ------------------------------------------------------------------ */

/** 大きい数を日本語で読める形に。DL 数は桁が大きいので万・億に丸める */
function jaCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 億`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString('ja-JP')} 万`;
  return n.toLocaleString('ja-JP');
}

export function buildEvidence(m: RadarMeasure, now: Date): string[] {
  const out: string[] = [];

  if (m.npmWeekly != null) {
    /*
     * パッケージ名とバージョンを必ず添える。**測った対象を隠さない**ため。
     * 名前解決を誤って別のパッケージを測っていた場合、数字だけでは気づけないが、
     * 「@tanstack/router 0.0.1-beta.53」と出ていれば目で分かる。
     */
    const label = [m.npmPackage, m.npmVersion].filter(Boolean).join(' ');
    out.push(`npm の ${label} で週 ${jaCount(m.npmWeekly)} ダウンロード`);
  }
  if (m.githubStars != null) out.push(`GitHub ${m.githubStars.toLocaleString('ja-JP')} スター`);

  const domestic = domesticThickness(m);
  if (domestic != null) {
    const parts: string[] = [];
    if (m.qiitaArticles != null) {
      parts.push(
        m.qiitaMethod === 'tag'
          ? `Qiita のタグ ${m.qiitaArticles} 本`
          : `Qiita ${m.qiitaArticles} 本`,
      );
    }
    if (m.zennArticles != null) {
      // 数え切れていないものは下限値なので、そう書く（判定側では既に落としている）
      parts.push(
        m.zennComplete === false ? `Zenn ${m.zennArticles} 本以上` : `Zenn ${m.zennArticles} 本`,
      );
    }
    out.push(`日本語の記事は ${domestic} 本（${parts.join(' / ')}）`);
  }

  if (m.npmTrend != null && m.npmTrend >= 1.15) {
    out.push(`ダウンロードが 2 週間で ${m.npmTrend.toFixed(2)} 倍`);
  }
  if (m.abroadMentions > 0) {
    out.push(`直近 ${MENTION_WINDOW_DAYS} 日で英語の記事に ${m.abroadMentions} 回`);
  }
  if (m.domesticMentions > 0) {
    out.push(`日本語の記事では ${m.domesticMentions} 回`);
  }
  if (m.githubPushedAt) {
    const days = Math.floor(daysSince(m.githubPushedAt, now));
    out.push(days <= 1 ? '今日も更新されている' : `最後の更新は ${days} 日前`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5) LLM に任せる 2 か所
 * ------------------------------------------------------------------ */

function resolveSystemPrompt(): string {
  return [
    'あなたは技術情報の整理を担当します。渡されるのは、技術記事から抽出された語のリストです。',
    'この語が「導入して使える道具」なのかを判定し、道具であれば npm のパッケージ名と',
    'GitHub のリポジトリを同定してください。',
    '',
    '# 最重要',
    'この後に、その道具が日本と海外でどれだけ使われているかを外部 API で計測します。',
    '**あなたに計測させることはありません。** 話題性・人気・将来性を推測しないでください。',
    'あなたの仕事は名前の同定だけです。',
    '',
    '# npm パッケージ名と GitHub リポジトリ',
    '確実に知っているものだけ書いてください。**推測で埋めると計測が丸ごと無駄になります**',
    '（存在しない名前は 404 になり、その道具の使用量が測れないまま候補から落ちます）。',
    '知らない場合の null は正しい答えです。',
  ].join('\n');
}

/** 台帳に無い語を同定する。結果は台帳に貯めるので、同じ語で二度は呼ばれない */
export async function resolveCandidates(
  backend: LlmBackend,
  candidates: readonly RadarCandidate[],
  cfg: RuntimeConfig,
): Promise<Map<string, NonNullable<RadarLedgerEntry['resolved']>>> {
  const out = new Map<string, NonNullable<RadarLedgerEntry['resolved']>>();
  if (candidates.length === 0) return out;

  const body = candidates
    .map((c, ref) => {
      const lines = [`[${ref}] ${c.name}`];
      if (c.repoHint) lines.push(`  GitHub: ${c.repoHint}`);
      if (c.via) lines.push(`  見つけた記事: ${truncate(c.via.title, 110)}`);
      return lines.join('\n');
    })
    .join('\n\n');

  let parsed: RadarResolveResult;
  try {
    parsed = await complete(backend, {
      stage: 'radar:resolve',
      model: cfg.rankModel,
      maxTokens: 8000,
      system: resolveSystemPrompt(),
      prompt: `以下 ${candidates.length} 件を判定してください。\n\n${body}`,
      schema: RadarResolveSchema,
    });
  } catch (err) {
    log.warn(`発掘の名前解決に失敗: ${err instanceof Error ? err.message : err}`);
    return out;
  }

  const at = new Date().toISOString();
  for (const r of parsed.items ?? []) {
    const candidate = candidates[r.ref];
    if (!candidate) continue;
    out.set(radarKey(candidate.name), {
      isTool: r.isTool,
      displayName: (r.canonicalName ?? '').trim() || candidate.name,
      // GitHub 由来の候補は owner/repo が観測済み。LLM の推測より観測を優先する
      githubRepo: candidate.repoHint ?? cleanRepo(r.githubRepo),
      npmPackage: cleanPackage(r.npmPackage),
      what: (r.what ?? '').trim(),
      nameIsCommonWord: r.nameIsCommonWord !== false,
      at,
    });
  }
  return out;
}

function cleanRepo(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  return v && /^[\w.-]+\/[\w.-]+$/.test(v) ? v : null;
}

function cleanPackage(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(v) ? v : null;
}

/** 紹介文に混ざると中身が消える語。schema で禁じているが、守られたか実行ログで見る */
const HYPE_WORDS = [
  'すごい', '凄い', '最高', '革命', '便利', '強力', '圧倒的', '話題の', '注目の',
  '爆速', '究極', '万能', '画期的', '劇的', '神ツール',
];

export function findHypeWords(text: string): string[] {
  return HYPE_WORDS.filter((w) => text.includes(w));
}

function pitchSystemPrompt(topics: TopicsConfig): string {
  return [
    '# 読者プロフィール',
    topics.profile,
    '',
    '# あなたの仕事',
    'この読者が、社内や知り合いのエンジニアに「この道具、知ってますか」と紹介するための',
    '言葉を用意します。**紹介の相手は同業のエンジニアで、読者本人ではありません。**',
    '',
    '# 数字を書かないこと',
    'ダウンロード数・スター数・記事数は、こちらで計測した実測値を別に添えます。',
    'あなたが数字を書くと、実測値と食い違ったものが画面に並び、読者はその数字を持って',
    '人に話しに行きます。**絶対に数字を書かないでください。**',
    '',
    '# 評価語を書かないこと',
    '「すごい」「便利」「強力」「爆速」「話題の」は書かないでください。',
    '評価は聞いた相手がするものです。読者が言えるのは「何ができるか」だけで、',
    'そこに評価語を混ぜた紹介は、聞いた側から見ると中身がありません。',
    '',
    '# 置き換え対象を名指しすること',
    '相手が今使っているものの名前が出た瞬間に話が通じます。',
    'insteadOf には、その道具が置き換える・不要にする既存の道具の名前を入れてください。',
  ].join('\n');
}

export interface PitchInput {
  key: string;
  name: string;
  what: string;
  npmPackage: string | null;
  githubRepo: string | null;
  /** 元記事のタイトル。何の文脈で出てきた道具なのかを渡す */
  viaTitle: string | null;
}

export async function writePitches(
  backend: LlmBackend,
  inputs: readonly PitchInput[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<Map<string, NonNullable<RadarLedgerEntry['pitch']>>> {
  const out = new Map<string, NonNullable<RadarLedgerEntry['pitch']>>();
  if (inputs.length === 0) return out;

  const body = inputs
    .map((i, ref) =>
      [
        `[${ref}] ${i.name}`,
        `  概要: ${i.what || '(不明)'}`,
        i.npmPackage ? `  npm: ${i.npmPackage}` : null,
        i.githubRepo ? `  GitHub: ${i.githubRepo}` : null,
        i.viaTitle ? `  見つけた記事: ${truncate(i.viaTitle, 110)}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  let parsed: RadarPitchResult;
  try {
    parsed = await complete(backend, {
      stage: 'radar:pitch',
      model: cfg.summaryModel,
      maxTokens: 6000,
      effort: cfg.summaryEffort,
      system: pitchSystemPrompt(topics),
      prompt: `以下 ${inputs.length} 件の紹介文を書いてください。\n\n${body}`,
      schema: RadarPitchSchema,
    });
  } catch (err) {
    log.warn(`発掘の紹介文の生成に失敗: ${err instanceof Error ? err.message : err}`);
    return out;
  }

  const at = new Date().toISOString();
  for (const r of parsed.items ?? []) {
    const input = inputs[r.ref];
    if (!input) continue;
    const pitch = (r.pitch ?? '').trim();
    if (!pitch) continue;
    const hype = findHypeWords(pitch);
    if (hype.length > 0) {
      log.warn(`  ${input.name} の紹介文に評価語が入りました: ${hype.join(' / ')}`);
    }
    out.set(input.key, {
      pitch,
      insteadOf: (r.insteadOf ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3),
      firstStep: r.firstStep?.trim() || null,
      fitFor: (r.fitFor ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3),
      caution: r.caution?.trim() || null,
      at,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6) 台帳と盤面の組み立て
 * ------------------------------------------------------------------ */

/** 候補を台帳に流し込む。既知の語は出現回数と最終確認日だけ更新する */
export function mergeCandidates(
  ledger: readonly RadarLedgerEntry[],
  candidates: readonly RadarCandidate[],
  date: string,
): RadarLedgerEntry[] {
  const byKey = new Map(ledger.map((e) => [radarKey(e.name), { ...e }]));

  for (const c of candidates) {
    const key = radarKey(c.name);
    const existing = byKey.get(key);
    if (existing) {
      existing.mentions = { abroad: c.abroad, domestic: c.domestic };
      existing.lastSeenAt = date;
      // GitHub から観測できた repo は、解決済みでも上書きする（観測 > 推測）
      if (existing.resolved && !existing.resolved.githubRepo && c.repoHint) {
        existing.resolved = { ...existing.resolved, githubRepo: c.repoHint };
      }
      continue;
    }
    byKey.set(key, {
      id: hashId('radar', key),
      name: c.name,
      resolved: null,
      measure: null,
      history: [],
      pitch: null,
      mentions: { abroad: c.abroad, domestic: c.domestic },
      firstSeenAt: date,
      lastSeenAt: date,
      featuredAt: null,
      lastVerdict: null,
      lastReason: null,
    });
  }
  return [...byKey.values()];
}

/**
 * 同じ道具を指す語をまとめる。
 *
 * keywords からは同じものが別の綴りで入ってくる。実測では「TanStack Table」と
 * 「@tanstack/table-core」が別の語として並んでいた。名前だけでは同じものだと
 * 判定できない（表記の距離を測っても Router と Table は近すぎる）が、
 * **名前解決の結果を見れば同じ npm パッケージ・同じリポジトリだと分かる**。
 *
 * 残すのは出現回数が多いほう。人が知っている呼び名のほうが多く出てくるので、
 * 「@tanstack/table-core」より「TanStack Table」が残る側になる。
 */
export function identityOf(e: RadarLedgerEntry): string {
  /*
   * リポジトリを最優先にする。npm パッケージ名は名前解決の産物なので誤りうるが、
   * リポジトリは GitHub から観測できたか、npm レジストリが公開している値なので確か。
   * 実測で「TanStack Table」と「@tanstack/table-core」は npm 名が食い違って
   * （片方は 404 で捨てられた）別々に残ったが、リポジトリは両方 TanStack/table だった。
   */
  return (
    e.resolved?.githubRepo?.toLowerCase() ??
    e.resolved?.npmPackage?.toLowerCase() ??
    radarKey(e.resolved?.displayName || e.name)
  );
}

/**
 * 代表として残す優先度。大きいほうを残す。
 *
 * ダウンロード数を出せるものを優先する。数字が 1 つ多いほうが紹介の根拠として強く、
 * かつ「測れなかった」欠測の顔をしたカードが盤面に残らない。
 */
function representativeRank(e: RadarLedgerEntry): number {
  const hasNpm = e.measure?.npmWeekly != null ? 1_000_000 : 0;
  const named = radarKey(e.name) === radarKey(e.resolved?.displayName ?? e.name) ? 1000 : 0;
  return hasNpm + named + e.mentions.abroad + e.mentions.domestic;
}

export function dedupeByIdentity(entries: readonly RadarLedgerEntry[]): RadarLedgerEntry[] {
  /*
   * 2 段でまとめる。1 段目が識別子（リポジトリか npm パッケージ）、
   * 2 段目が表示名。**順番に意味がある**——識別子で同じと分かったものを
   * 表示名で分け直してはいけないので、識別子を先に潰してから名前を見る。
   *
   * 2 段目が要るのは、識別子が食い違ったまま同じ名前になる場合があるため。
   * 同じ名前のカードが 2 枚並ぶのは、どんな理由があっても壊れて見える。
   */
  const collapse = (list: readonly RadarLedgerEntry[], key: (e: RadarLedgerEntry) => string) => {
    const best = new Map<string, RadarLedgerEntry>();
    for (const e of list) {
      const k = key(e);
      const kept = best.get(k);
      if (!kept || representativeRank(e) > representativeRank(kept)) best.set(k, e);
    }
    const survivors = new Set(best.values());
    // 入力の順番を保つ（呼び出し側が優先順位で並べてから渡してくる）
    return list.filter((e) => survivors.has(e));
  };

  const byIdentity = collapse(entries, identityOf);
  return collapse(byIdentity, (e) => radarKey(e.resolved?.displayName || e.name));
}

/**
 * 失敗した計測を捨てるまでの日数。
 *
 * 判定できなかった計測を `remeasureAfterDays`（既定 14 日）まで抱えると、
 * Qiita がレート上限を返した 1 回の実行のせいで、その語が 2 週間ずっと
 * 盤面に出てこなくなる。復帰できないのはおかしいので短く retry する。
 * 毎日にはしない——名前が API 側で永久に引けない語もあり、それが毎日
 * 予算を食い続けるのを避ける。
 */
const RETRY_FAILED_AFTER_DAYS = 1;

/** 再計測が必要か。盤面の安定と API の呼び出し数を両立させるための間隔 */
export function needsMeasure(entry: RadarLedgerEntry, cfg: RadarConfig, now: Date): boolean {
  if (!entry.resolved?.isTool) return false;
  if (!entry.measure) return true;
  const age = daysSince(entry.measure.measuredAt, now);
  // 判定に至らなかった計測（国内の記事数が欠けている）は短い間隔で測り直す
  const interval =
    domesticThickness(entry.measure) == null ? RETRY_FAILED_AFTER_DAYS : cfg.remeasureAfterDays;
  return age >= interval;
}

/**
 * 計測の優先順位。まだ一度も測っていないものを先に測る。
 *
 * 予算を超えた分は今日測らないので、この順番が「何を先に見つけるか」になる。
 * 一度失敗した語を先に置くと、API 側で永久に引けない語が毎日予算の先頭を
 * 占め、新しい候補がいつまでも測られない。
 */
export function measureOrder(a: RadarLedgerEntry, b: RadarLedgerEntry): number {
  const virgin = (e: RadarLedgerEntry) => (e.measure ? 0 : 1);
  if (virgin(a) !== virgin(b)) return virgin(b) - virgin(a);
  return b.mentions.abroad - a.mentions.abroad;
}

/** 道具でなかった語を、しばらく見かけなくなったら台帳から落とす */
export function pruneLedger(ledger: readonly RadarLedgerEntry[], date: string): RadarLedgerEntry[] {
  const today = Date.parse(`${date}T00:00:00Z`);
  return ledger.filter((e) => {
    if (e.resolved?.isTool !== false) return true;
    const age = (today - Date.parse(`${e.lastSeenAt}T00:00:00Z`)) / 86_400_000;
    return !(age > LEDGER_TTL_DAYS);
  });
}

/** 読者の関心トピックにどれだけ近いか。0〜1 */
function affinityOf(name: string, what: string, topics: TopicsConfig): number {
  const hay = `${name} ${what}`.toLowerCase();
  let best = 0;
  for (const topic of topics.topics) {
    if (topic.keywords.some((k) => k.length >= 2 && hay.includes(k))) {
      best = Math.max(best, topic.weight / 5);
    }
  }
  return best;
}

export interface RadarInput {
  entries: readonly IndexEntry[];
  items: readonly RawItem[];
  ledger: readonly RadarLedgerEntry[];
  previousIds: ReadonlySet<string>;
  date: string;
  now: Date;
}

export interface RadarResult {
  board: RadarBoard;
  ledger: RadarLedgerEntry[];
}

export async function collectRadar(
  cfg: RadarConfig,
  runtime: RuntimeConfig,
  topics: TopicsConfig,
  backend: LlmBackend | null,
  input: RadarInput,
): Promise<RadarResult> {
  const notes: string[] = [];
  const { date, now } = input;

  const candidates = collectCandidates(input.entries, input.items, cfg, topics);
  log.info(`  候補 ${candidates.length} 語（台帳 ${input.ledger.length} 語）`);

  let ledger = mergeCandidates(input.ledger, candidates, date);

  /* 名前解決。台帳に無い語だけ、予算のぶんだけ ------------------------- */
  const unresolved = ledger
    .filter((e) => e.resolved == null)
    .sort((a, b) => b.mentions.abroad - a.mentions.abroad)
    // 解決は安いが無限ではない。1 回で見る語数を計測予算の 2 倍までに抑える
    .slice(0, cfg.measureBudget * 2);

  if (unresolved.length > 0 && backend) {
    const asCandidates = unresolved.map<RadarCandidate>((e) => ({
      name: e.name,
      abroad: e.mentions.abroad,
      domestic: e.mentions.domestic,
      via: candidates.find((c) => radarKey(c.name) === radarKey(e.name))?.via ?? null,
      repoHint: e.resolved?.githubRepo ?? null,
    }));
    const resolved = await resolveCandidates(backend, asCandidates, runtime);
    ledger = ledger.map((e) => {
      const r = resolved.get(radarKey(e.name));
      return r ? { ...e, resolved: r } : e;
    });
    const toolCount = [...resolved.values()].filter((r) => r.isTool).length;
    log.info(`  名前解決 ${resolved.size} 語 → 道具は ${toolCount} 語`);
  } else if (unresolved.length > 0) {
    notes.push('LLM バックエンドが未設定のため、新しい候補の同定ができていません。');
  }

  /*
   * 同じ道具を指す語をここで 1 回だけまとめる。
   *
   * 以前は「計測対象の中で」まとめていたが、それでは足りなかった。既に計測済みの
   * 兄弟（TanStack Table）は計測対象に入らないので、まだ計測していない別綴り
   * （@tanstack/table-core）と突き合わされず、2 つとも計測されて 2 つとも
   * 判定を通っていた。しかも後者は国内の記事数を「TanStack Table Core」で
   * 引くので 0 本になり、**間違ったほうが代表として盤面に出た**。
   *
   * 母集団の側でまとめてしまえば、計測も判定も 1 つしか通らない。
   */
  const tools = dedupeByIdentity(
    ledger
      .filter((e) => e.resolved?.isTool)
      .sort((a, b) => b.mentions.abroad - a.mentions.abroad),
  );
  const representative = new Set(tools.map((e) => e.id));
  const collapsed = ledger.filter((e) => e.resolved?.isTool).length - tools.length;
  if (collapsed > 0) log.info(`  同じ道具を指す ${collapsed} 語をまとめました`);

  /* 計測。予算のぶんだけ --------------------------------------------- */
  const targets = tools
    .filter((e) => needsMeasure(e, cfg, now))
    .sort(measureOrder)
    .slice(0, cfg.measureBudget);

  if (targets.length > 0) {
    log.info(`  計測 ${targets.length} 語（1 語あたり最大 4 リクエスト）`);
    // 並列 4。Qiita は未認証で 60 リクエスト/時なので、ここを上げても速くならない
    const measured = await mapLimit(targets, 4, async (entry) => ({
      key: radarKey(entry.name),
      outcome: await measureTool(entry, now),
    }));
    const byKey = new Map(measured.map((r) => [r.key, r.outcome]));
    ledger = ledger.map((e) => {
      const outcome = byKey.get(radarKey(e.name));
      if (!outcome) return e;
      const m = outcome.measure;
      return {
        ...e,
        resolved:
          outcome.clearNpmPackage && e.resolved
            ? { ...e.resolved, npmPackage: null }
            : e.resolved,
        measure: m,
        history: [
          ...e.history,
          {
            at: m.measuredAt,
            npmWeekly: m.npmWeekly,
            githubStars: m.githubStars,
            domestic: domesticThickness(m),
          },
        ].slice(-8),
      };
    });

    /*
     * Qiita が測れなかった件数を数える。未認証のレート上限（60 リクエスト/時）は
     * 運用で必ず当たり、当たった実行では判定が丸ごと成立しない。その日は
     * 「該当なし」ではなく「測れなかった」なので、区別できるようにしておく。
     */
    const qiitaFailed = measured.filter((r) => r.outcome.measure.qiitaArticles == null).length;
    if (qiitaFailed > 0) {
      log.warn(
        `  Qiita の記事数を ${qiitaFailed}/${measured.length} 語で取得できませんでした` +
          '（未認証は 60 リクエスト/時）。該当分は判定を保留します',
      );
      if (qiitaFailed >= Math.ceil(measured.length / 2)) {
        notes.push(
          `Qiita の記事数を ${qiitaFailed} 語ぶん取得できなかったため、今回はその分の判定を` +
            '保留しています（レート上限の可能性があります）。QIITA_TOKEN を登録するか、' +
            'config/radar.json の measureBudget を下げてください。',
        );
      }
    }
  }

  /* 判定 ------------------------------------------------------------- */
  const judged: { entry: RadarLedgerEntry; verdict: RadarVerdict; score: number }[] = [];
  ledger = ledger.map((e) => {
    // 代表でない綴りは判定にかけない（同じ道具が 2 枚のカードになるのを防ぐ）
    if (!e.measure || !e.resolved?.isTool || !representative.has(e.id)) {
      return { ...e, lastVerdict: null, lastReason: e.resolved?.isTool === false ? '道具ではない' : e.lastReason };
    }
    const affinity = affinityOf(e.name, e.resolved.what, topics);
    const j = judge(e.measure, cfg, { now, affinity });
    const next = { ...e, lastVerdict: j.verdict, lastReason: j.reason };
    if (j.verdict) judged.push({ entry: next, verdict: j.verdict, score: j.score });
    return next;
  });

  /* 枠に詰める ------------------------------------------------------- */
  const picked: { entry: RadarLedgerEntry; verdict: RadarVerdict; score: number }[] = [];
  for (const verdict of RADAR_VERDICTS) {
    const matching = judged.filter((j) => j.verdict === verdict).sort((a, b) => b.score - a.score);
    const pool = matching.slice(0, cfg.limits[verdict] ?? 0);
    picked.push(...pool);
    log.info(
      `  ${verdict}: ${pool.length} 件（該当 ${matching.length}）`,
    );
  }

  /* 紹介文。キャッシュが無いものだけ --------------------------------- */
  const needPitch = picked.filter((p) => p.entry.pitch == null);
  if (needPitch.length > 0 && backend) {
    const inputs = needPitch.map<PitchInput>((p) => ({
      key: radarKey(p.entry.name),
      name: p.entry.name,
      what: p.entry.resolved?.what ?? '',
      npmPackage: p.entry.measure?.npmPackage ?? null,
      githubRepo: p.entry.measure?.githubRepo ?? null,
      viaTitle: candidates.find((c) => radarKey(c.name) === radarKey(p.entry.name))?.via?.title ?? null,
    }));
    const pitches = await writePitches(backend, inputs, topics, runtime);
    log.info(`  紹介文 ${pitches.size}/${needPitch.length} 件`);
    const apply = (e: RadarLedgerEntry) => {
      const p = pitches.get(radarKey(e.name));
      return p ? { ...e, pitch: p } : e;
    };
    ledger = ledger.map(apply);
    for (const p of picked) p.entry = apply(p.entry);
  } else if (needPitch.length > 0) {
    notes.push('LLM バックエンドが未設定のため、紹介文は生成されていません。');
  }

  /* 盤面 ------------------------------------------------------------- */
  const items: RadarItem[] = [];
  for (const p of picked) {
    const e = p.entry;
    const m = e.measure;
    if (!m) continue;
    const via = candidates.find((c) => radarKey(c.name) === radarKey(e.name))?.via ?? null;
    items.push({
      id: e.id,
      name: e.resolved?.displayName || e.name,
      verdict: p.verdict,
      score: p.score,
      what: e.resolved?.what ?? '',
      pitch: e.pitch?.pitch ?? '',
      insteadOf: e.pitch?.insteadOf ?? [],
      firstStep: resolveFirstStep(m, e.pitch?.firstStep ?? null),
      fitFor: e.pitch?.fitFor ?? [],
      caution: e.pitch?.caution ?? null,
      measure: m,
      evidence: buildEvidence(m, now),
      links: buildLinks(e, m),
      /*
       * 試すプロンプトは計測値から機械的に組む（LLM を通さない = 追加費用ゼロ）。
       * npm があれば版まで固定でき、無ければリポジトリを clone する。
       */
      tryPrompt: buildTryPrompt(
        { npmPackage: m.npmPackage, npmVersion: m.npmVersion, githubRepo: m.githubRepo },
        {
          goal: `${e.resolved?.displayName || e.name} を入れて、最初の出力が出るまで動かす`,
          url: m.githubRepo
            ? `https://github.com/${m.githubRepo}`
            : `https://www.npmjs.com/package/${m.npmPackage ?? ''}`,
          questions: radarQuestions({
            npmVersion: m.npmVersion,
            domesticArticles: (m.qiitaArticles ?? 0) + (m.zennArticles ?? 0),
          }),
        },
      ),
      firstSeenAt: e.firstSeenAt,
      isNew: !input.previousIds.has(e.id),
      foundVia: via,
    });
  }
  items.sort((a, b) => b.score - a.score);

  // 盤面に載った日を台帳へ記録する（初回だけ）
  const featured = new Set(items.map((i) => i.id));
  ledger = pruneLedger(
    ledger.map((e) => (featured.has(e.id) && !e.featuredAt ? { ...e, featuredAt: date } : e)),
    date,
  );

  const notTool = ledger.filter((e) => e.resolved?.isTool === false).length;
  const board: RadarBoard = {
    updatedAt: now.toISOString(),
    date,
    items,
    byVerdict: Object.fromEntries(
      RADAR_VERDICTS.map((v) => [v, items.filter((i) => i.verdict === v).length]),
    ),
    stats: { ledgerSize: ledger.length, measuredToday: targets.length, notTool },
    notes,
  };
  return { board, ledger };
}

/** npm のパッケージ名を含むコマンドか。検証できない名前を読者に打たせないための判定 */
const NPM_COMMAND = /\b(npm\s+(i|install|add)|pnpm\s+add|yarn\s+add|bun\s+add|npx)\b/;

/**
 * 最初に打つコマンド。
 *
 * 検証済みの npm パッケージがあるときは**機械で組み立てる**。LLM に書かせると
 * 名前解決の誤りがそのままコマンドに入り、読者が打って失敗する（実測で
 * `npm i @tanstack/table` が出た。存在しないパッケージ）。
 *
 * 検証済みの名前が無いのに LLM が npm のコマンドを書いてきた場合は**捨てる**。
 * その状況は「LLM が挙げた npm 名がレジストリに無かった」か「そもそも挙げられ
 * なかった」のどちらかで、いずれもこの道具について LLM の npm 知識が当てに
 * ならないことが既に分かっている。たまたま正しいこともあるが、**打って失敗する
 * コマンドを 1 度でも出す損失のほうが大きい**——この枠の値打ちは、書いてある
 * ことをそのまま人に言えることだけで成り立っている。npm の外のコマンド
 * （brew / cargo / docker）はそのまま使う。
 */
export function resolveFirstStep(m: RadarMeasure, fromLlm: string | null): string | null {
  if (m.npmPackage) return `npm i ${m.npmPackage}`;
  if (!fromLlm) return null;
  return NPM_COMMAND.test(fromLlm) ? null : fromLlm;
}

function buildLinks(entry: RadarLedgerEntry, m: RadarMeasure): RadarItem['links'] {
  const links: RadarItem['links'] = [];
  if (m.githubRepo) links.push({ label: 'GitHub', url: `https://github.com/${m.githubRepo}` });
  if (m.npmPackage) {
    links.push({ label: 'npm', url: `https://www.npmjs.com/package/${m.npmPackage}` });
  }
  // 日本語で何が書かれているかを自分で確かめられる導線。数字の裏取りに使う
  links.push({
    label: 'Qiita で検索',
    url: `https://qiita.com/search?q=${encodeURIComponent(entry.name)}`,
  });
  links.push({
    label: 'Zenn で検索',
    url: `https://zenn.dev/search?q=${encodeURIComponent(entry.name)}`,
  });
  return links;
}
