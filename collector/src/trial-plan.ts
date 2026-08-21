import type { TrialPlan } from './types.js';

/**
 * 「試す計画」を、道具の身元から機械的に組み立てる。
 *
 * 作るレーンの記事では LLM に判定させている（道具の身元が本文の中にしか無いので、
 * 読み取れたかどうかに依存する）。実測すると 14 日で 24 枚中 3 枚しか通らなかった。
 *
 * 一方、発掘・リリース情報・その他候補は**身元が構造化データで分かっている**。
 * 発掘は npm と GitHub を実測して作った板なのでパッケージ名とリポジトリを持ち、
 * リリースとその他候補は URL がそのまま GitHub リポジトリを指している。
 * ここから `npm i pkg@ver` / `git clone` を導くのに判断は要らない——
 * **LLM を通さないので追加費用もゼロで、null になる余地も無い。**
 *
 * 実測（直近 14 日）:
 *   発掘 7/7 件 / リリース 60/119 件 / その他候補 36/168 件（GitHub 枠は 35/35）
 */

/** 身元。npm と GitHub の両方が分かっているときは npm を優先する（版が固定できる） */
export interface TrialIdentity {
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
export function identityFromUrl(url: string | null | undefined): TrialIdentity | null {
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

/**
 * 身元から計画を組む。身元が無ければ null（＝ボタンを出さない）。
 *
 * @param questions 何を確かめたいか。呼び出し側の枠ごとに違うので受け取る。
 *   ここが空の計画は作らない——目的は動作確認ではなく、試した結果からしか
 *   分からないことを持ち帰ることなので、問いの無い試行は価値が無い。
 */
export function buildTrialPlan(
  identity: TrialIdentity | null,
  questions: string[],
): TrialPlan | null {
  if (!identity || questions.length === 0) return null;

  const pkg = identity.npmPackage?.trim();
  const repo = identity.githubRepo?.trim();

  if (pkg) {
    const version = identity.npmVersion?.trim();
    const spec = version ? `${pkg}@${version}` : pkg;
    return {
      runner: 'node',
      install: `npm i -g ${spec} || npm i ${spec}`,
      /*
       * 版が入っていることだけは必ず確かめられる形にする。CLI かライブラリかは
       * 事前に分からないので、`npm ls` で入ったことを見てから中身へ進ませる。
       */
      verify: `npm ls -g --depth=0 ${pkg} || npm ls --depth=0 ${pkg}`,
      questions,
    };
  }

  if (repo) {
    const branch = identity.tag ? ` --branch ${identity.tag}` : '';
    return {
      runner: 'shell',
      install: `git clone --depth 1${branch} https://github.com/${repo}`,
      verify: `ls ${repo.split('/')[1]}`,
      questions,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 枠ごとの問い
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
      ? `「${opts.unlock.slice(0, 40)}」を実際に確かめられるか`
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
