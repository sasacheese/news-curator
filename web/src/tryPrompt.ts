/**
 * 「試し方」を、そのまま貼って試し始められるプロンプトとして組む。
 *
 * 記事に依存する本文（試すこと / 手順 / 確認したいこと / 前提・注意）は collector が
 * 書いてくる（`tryPrompt`）。ここで足すのは**作業のさせ方**の固定文だけ——
 * 作業ディレクトリ、始める前に段取りを出させること、終わったら何を報告させるか。
 * 生成し直さずに変えられるよう、collector 側には持たせていない。
 *
 * 渡し方は「開く先」ごとに違う。ローカルの Claude Code には `claude-cli://` の
 * ディープリンクで最初から入った状態で開ける（Enter を押すまで何も走らない）。
 * クラウドの Linux 環境は URL で文字列を受け取れないので、開いてから貼る。
 * どのボタンも押した時点でクリップボードに入れるのは、そのため。
 */

/** 本文の 4 節。collector 側の TRY_PROMPT_HEADINGS と同じ */
const HEADINGS = ['# 試すこと', '# 手順', '# 確認したいこと', '# 前提・注意'] as const;

/**
 * `claude-cli://open?q=` に載せられる上限（文字数）。公式ドキュメントの値。
 * 本文は collector 側で 1,200 字に縛ってあるので、通常はここに当たらない。
 */
const DEEP_LINK_MAX_CHARS = 5000;

/** 要約に失敗した日の howToTry。手順ではないので、これからプロンプトは組まない */
const FAILED_PLACEHOLDER = '元記事を開いて確認してください。';

export interface TryPromptSource {
  /** collector が書いた本文。無い日・null の項目は howToTry から組む */
  tryPrompt?: string | null;
  title: string;
  url: string;
  /** 作るレーンのカードだけが持つ。tryPrompt が無いときの材料 */
  howToTry?: string[];
}

/**
 * 貼れる 1 つの文を返す。材料が無ければ null（＝箱を出さない）。
 */
export function buildTryPrompt(src: TryPromptSource): string | null {
  const body = src.tryPrompt?.trim() || fallbackBody(src);
  if (!body) return null;
  return `${body}\n\n---\n${footer(slugFor(src))}`;
}

/**
 * tryPrompt を持たない日のカード（この機能より前の日、生成できなかった記事）向けに、
 * howToTry の箇条書きを同じ 4 節に包む。
 *
 * 目標はタイトルで代用し、「確認したいこと」は手順が通るかだけにする。
 * 生成した本文より薄いが、形が同じなら貼る先は同じ扱いで読める。
 */
function fallbackBody(src: TryPromptSource): string | null {
  const steps = (src.howToTry ?? []).map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0 || (steps.length === 1 && steps[0] === FAILED_PLACEHOLDER)) return null;
  return [
    HEADINGS[0],
    `${src.title} を動かして、掲載の手順の最後まで到達する`,
    src.url,
    '',
    HEADINGS[1],
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    HEADINGS[2],
    '- 掲載の手順どおりに最初の出力まで到達できるか',
    '- 手順に書かれていない前提（別のツール・鍵・環境）は何か',
    '',
    HEADINGS[3],
    '- 手順は記事から抜き出したもの。コマンドは元記事と README を正とする',
  ].join('\n');
}

/**
 * 作業のさせ方。本文の下に `---` で区切って付ける。
 *
 * 「まず段取りを出して OK を待つ」を入れているのは、貼った直後に走り出されると
 * 何を試すのかを読者が確認する間が無いから。終わりの報告の形を決めているのは、
 * 掲載していた手順とのずれ（古い・足りない）を持ち帰らせるため。
 */
function footer(slug: string): string {
  return [
    `~/lab/${slug}/ を作業ディレクトリにして、その外は触らないで。`,
    'まず手順を読んで「何を・どの順で・何分で」を 3 行で提案し、私の OK を待ってから始めて。',
    '分からない箇所は元記事と README を開いて確かめて。',
    '終わったら「動いた / 動かなかった / 詰まった箇所 / 掲載の手順との違い」を 5 行以内で。',
  ].join('\n');
}

/**
 * 作業ディレクトリ名。GitHub のリポジトリ名が取れればそれ、無ければタイトルから。
 *
 * 日本語のタイトルは記号を落とすと空になることがあるので、そのときは `try` に落とす。
 */
export function slugFor(src: { title: string; url: string }): string {
  const gh = /^https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)/.exec(src.url);
  const raw = gh?.[1] ?? src.title;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'try';
}

/* ---------- 開く先 ---------- */

export interface TryExit {
  key: 'claude' | 'iximiuz' | 'codespaces' | 'cloudshell';
  label: string;
  /** hover で出す説明 */
  title: string;
  /** プロンプトを URL に載せて開けるか。false なら開いたあとに貼る */
  carriesPrompt: boolean;
  href(prompt: string): string;
}

/**
 * 並べる順に意味がある。プロンプトが最初から入る Claude Code を先頭に、
 * あとは「使い捨てで即」「永続する」「予備」の順。
 */
export const TRY_EXITS: readonly TryExit[] = [
  {
    key: 'claude',
    label: '▶ Claude Code で開く',
    title:
      'この Mac の Claude Code を新しいターミナルで開き、このプロンプトを入力欄に入れます。' +
      'Enter を押すまで何も実行されません。Claude Code が入っていない端末では動きません。',
    carriesPrompt: true,
    href: (prompt) => `claude-cli://open?q=${encodeURIComponent(fitForDeepLink(prompt))}`,
  },
  {
    key: 'iximiuz',
    label: '☁ iximiuz Labs',
    title:
      '使い捨ての Ubuntu を開きます（Claude Code 入り。無料枠は 1 日 1 時間）。' +
      '開いたら claude を起動して、クリップボードのプロンプトを貼ってください。',
    carriesPrompt: false,
    href: () => 'https://labs.iximiuz.com/playgrounds/coding-agent-base',
  },
  {
    key: 'codespaces',
    label: '☁ Codespaces',
    title:
      'GitHub Codespaces の空の環境を開きます（永続。無料枠は 2 コアで月 60 時間）。' +
      '開いたら Claude Code を入れて、クリップボードのプロンプトを貼ってください。',
    carriesPrompt: false,
    href: () => 'https://codespaces.new/github/codespaces-blank?quickstart=1',
  },
  {
    key: 'cloudshell',
    label: '☁ Cloud Shell',
    title:
      'Google Cloud Shell のターミナルを開きます（無料。週 50 時間、ホーム 5GB が残る）。' +
      '開いたら Claude Code を入れて、クリップボードのプロンプトを貼ってください。',
    carriesPrompt: false,
    href: () => 'https://shell.cloud.google.com/?show=terminal',
  },
];

/**
 * ディープリンクの上限に収める。
 *
 * 超えたときは本文の後ろの節から落とす（前提・注意 → 確認したいこと）。末尾の固定文は
 * 作業のさせ方なので残す。それでも超えるなら切る——クリップボードには全文が入るので、
 * 貼れば失われない。
 */
export function fitForDeepLink(prompt: string, max = DEEP_LINK_MAX_CHARS): string {
  const length = (s: string) => Array.from(s).length;
  if (length(prompt) <= max) return prompt;

  const sep = '\n\n---\n';
  const at = prompt.lastIndexOf(sep);
  let body = at >= 0 ? prompt.slice(0, at) : prompt;
  const tail = at >= 0 ? prompt.slice(at) : '';

  // 後ろの節から落とす。「試すこと」と「手順」は残す
  for (const heading of [HEADINGS[3], HEADINGS[2]]) {
    if (length(body + tail) <= max) break;
    const i = body.lastIndexOf(`\n${heading}`);
    if (i > 0) body = body.slice(0, i).trimEnd();
  }
  const joined = body + tail;
  if (length(joined) <= max) return joined;
  return Array.from(joined).slice(0, max - 1).join('') + '…';
}

/**
 * 開く先を出すか。マウスのある画面（PC）でだけ出す。
 *
 * スマホでは Claude Code のディープリンクは動かず、クラウド環境も操作できないので、
 * 列そのものが要らない。コピーだけは端末を問わず出す。
 */
export function canOpenExits(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
}
