/**
 * 「試し方」を、そのまま貼って試し始められるプロンプトの形にする。
 *
 * 読者はこの文をコピーして、自分の端末の Claude Code か、クラウドの Linux 環境に貼る。
 * 以前はサンドボックスで AI に代わりに試させていたが、読者が自分で試す導線に
 * 置き換えた——人が横にいるので、「サインアップが要る」のような人間しか踏めない
 * 手順も、禁じるのではなく「（手動）」と印を付けて書ける。
 *
 * 形は 4 節に固定する（見出しの文言も順番も変えない）。読者が目で追う位置を
 * 固定するためで、LLM が書く本文（作るレーン）とテンプレートで組む本文
 * （その他候補・リリース・発掘）が同じ形になる。
 *
 * ここにあるのは 2 つ:
 * - 身元（npm / GitHub）から機械的に組むテンプレート。LLM を通さないので費用ゼロ
 * - LLM が書いた本文の検査。4 節が揃っていなければ null（＝出さない）
 */

/** 4 節の見出し。この順で、行頭に `# ` を付けて現れなければならない */
export const TRY_PROMPT_HEADINGS = ['# 試すこと', '# 手順', '# 確認したいこと', '# 前提・注意'] as const;

/**
 * 本文の上限（文字数）。
 *
 * サイト側が末尾に作業のさせ方（300 字弱）を足し、そのまま `claude-cli://` の
 * `q`（上限 5,000 字）にも載せる。本文をここで縛っておけば、リンク側で節を
 * 落とす処理がほぼ走らない。
 */
export const TRY_PROMPT_MAX = 1200;

/**
 * LLM が書いた本文を検査する。形が崩れていれば null。
 *
 * 見るのは形だけ——4 つの見出しがこの順で行頭にあり、長さが上限以内であること。
 * 中身の良し悪しはプロンプト側の仕事で、ここで文字列検査をしても守れない。
 * **null を返す = そのカードに試し方の箱を出さない**（過去の日と同じく、howToTry の
 * 箇条書きから組んだ代替が出る）。
 */
export function sanitizeTryPrompt(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) return null;
  if (Array.from(body).length > TRY_PROMPT_MAX) return null;

  const lines = body.split('\n').map((l) => l.trim());
  let cursor = 0;
  for (const heading of TRY_PROMPT_HEADINGS) {
    const at = lines.findIndex((l, i) => i >= cursor && l === heading);
    if (at < 0) return null;
    cursor = at + 1;
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * 身元からテンプレートで組む
 * ------------------------------------------------------------------ */

/** 身元。npm と GitHub の両方が分かっているときは npm を優先する（版が固定できる） */
export interface TryIdentity {
  npmPackage?: string | null;
  npmVersion?: string | null;
  githubRepo?: string | null;
  /** リリースのタグなど、取れているなら固定したい版 */
  tag?: string | null;
}

/**
 * URL から身元を読む。
 *
 * `github.com/owner/repo` のリポジトリ直リンクだけを拾う。`/releases/tag/v1.2.3` の
 * ような下位パスは owner/repo を取り出したうえでタグも拾う。Qiita や Zenn の記事
 * URL からは何も取れない——それは道具ではなく記事なので、正しく何も返さない。
 */
export function identityFromUrl(url: string | null | undefined): TryIdentity | null {
  if (!url) return null;

  const npm = /^https?:\/\/(?:www\.)?npmjs\.com\/package\/(@?[\w.-]+(?:\/[\w.-]+)?)/.exec(url);
  if (npm) return { npmPackage: npm[1] };

  const gh = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(\/.*)?$/.exec(url);
  if (gh) {
    const [, owner, repo, rest] = gh;
    // owner/repo 以外の入口（/orgs/... など）は道具の身元ではない
    if (!owner || !repo || repo === '.' || repo === '..') return null;
    const tag = rest ? /\/releases\/tag\/([^/?#]+)/.exec(rest)?.[1] : undefined;
    return { githubRepo: `${owner}/${repo}`, tag: tag ?? null };
  }
  return null;
}

export interface TryTemplateInput {
  /** 「試すこと」の 1 行。何を入れて何を確かめるか */
  goal: string;
  /** 元の URL。目標の次の行に置く */
  url: string;
  /** 確認したいこと。空なら組まない（動作確認だけの試行に価値は無い） */
  questions: string[];
}

/**
 * 身元からプロンプトを組む。身元が無ければ null（＝箱を出さない）。
 *
 * 手順は「入れる → 入ったことを見る → README で先へ進む」の 3 段で固定する。
 * CLI かライブラリかは事前に分からないので、入ったことの確認までを機械的に書き、
 * そこから先は README を正として読者（と、読者が貼った先のエージェント）に任せる。
 */
export function buildTryPrompt(
  identity: TryIdentity | null,
  input: TryTemplateInput,
): string | null {
  if (!identity) return null;
  const questions = input.questions.map((q) => q.trim()).filter(Boolean);
  if (questions.length === 0) return null;

  const pkg = identity.npmPackage?.trim();
  const repo = identity.githubRepo?.trim();

  let steps: string[];
  let notes: string[];
  if (pkg) {
    const version = identity.npmVersion?.trim();
    const spec = version ? `${pkg}@${version}` : pkg;
    steps = [
      `npm i -g ${spec} || npm i ${spec}`,
      `npm ls -g --depth=0 ${pkg} || npm ls --depth=0 ${pkg}`,
      'README の Usage / Quick start の最初の例を 1 つ動かす',
    ];
    notes = ['Node.js と npm が入っていること', 'CLI かライブラリかは README で確かめる'];
  } else if (repo) {
    const branch = identity.tag ? ` --branch ${identity.tag}` : '';
    const dir = repo.split('/')[1];
    steps = [
      `git clone --depth 1${branch} https://github.com/${repo}`,
      `cd ${dir} && ls`,
      'README の手順どおりに依存を入れ、最初の出力が出るまで進める',
    ];
    notes = [
      'git が入っていること',
      identity.tag
        ? `${identity.tag} のタグを固定して clone している。main が要るなら --branch を外す`
        : 'README にビルド手順が無ければ、リポジトリの package.json / Makefile を見る',
    ];
  } else {
    return null;
  }

  return sanitizeTryPrompt(
    [
      TRY_PROMPT_HEADINGS[0],
      input.goal.trim(),
      input.url.trim(),
      '',
      TRY_PROMPT_HEADINGS[1],
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      TRY_PROMPT_HEADINGS[2],
      ...questions.map((q) => `- ${q}`),
      '',
      TRY_PROMPT_HEADINGS[3],
      ...notes.map((n) => `- ${n}`),
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ *
 * 枠ごとの「確認したいこと」
 *
 * 決め打ちにしている。LLM に書かせると 1 件ごとに費用がかかるうえ、
 * 枠の性格から決まる問いはほぼ同じだった（「入るか」「動くまでに何が要るか」）。
 * 数字や版のように、その項目でしか言えないものだけを差し込む。
 * ------------------------------------------------------------------ */

/** 発掘: 「隠れた定番」の主張を、外形の数字ではなく実行で確かめる */
export function radarQuestions(opts: {
  npmVersion?: string | null;
  domesticArticles?: number | null;
}): string[] {
  const version = opts.npmVersion ? `${opts.npmVersion} を` : '';
  return [
    `${version}インストールして、最初の出力が出るまで到達できるか`,
    '動かすのに別途何が必要か（API キー・GUI・別のツール）',
    opts.domesticArticles && opts.domesticArticles > 0
      ? `日本語の記事 ${opts.domesticArticles} 本に書かれていない詰まりどころはあるか`
      : '公式のドキュメントだけで詰まらずに進めるか',
  ];
}

/** リリース情報: 「この版で何ができるようになったか」を実際に踏む */
export function releaseQuestions(opts: {
  version?: string | null;
  unlock?: string | null;
}): string[] {
  const version = opts.version?.trim();
  return [
    version ? `${version} が実際に入って動くか` : '新しい版が実際に入って動くか',
    opts.unlock
      ? `「${Array.from(opts.unlock).slice(0, 40).join('')}」を実際に確かめられるか`
      : 'リリースノートに書かれた変更を実際に確かめられるか',
    '既存の使い方のまま上げたときに壊れる箇所はあるか',
  ];
}

/** その他候補: 名前しか知らない道具が、そもそも動く状態にあるか */
export function otherQuestions(): string[] {
  return [
    'README の手順だけで、最初の出力まで到達できるか',
    '動かすのに別途何が必要か（API キー・GUI・別のツール）',
  ];
}
