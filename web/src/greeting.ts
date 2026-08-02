/**
 * コンソールを開いた人への挨拶。
 *
 * 開いた瞬間を検出する方法は無いので（devtools の開閉はページから見えない）、
 * 読み込み時に一度出しておいて、後から開いた人にも履歴として残るようにしている。
 *
 * StrictMode は開発時にエフェクトを二重に呼ぶので、モジュールのトップレベルで
 * 一度だけ実行する（コンポーネント側でやると 2 回出る）。
 */

const ART = String.raw`
   ______         __        ____  _                 __
  /_  __/__  ____/ /_      / __ \(_)___ ____  _____/ /_
   / / / _ \/ ___/ __ \   / / / / / __ \/ _ \/ ___/ __/
  / / /  __/ /__/ / / /  / /_/ / / /_/ /  __/ /_  / /_
 /_/  \___/\___/_/ /_/  /_____/_/\__, /\___/\___/ \__/
                                /____/
`;

export function greetConsole(): void {
  // ロゴはアクセント色、説明は地の文の色。等幅でないとアートが崩れる
  console.log(
    `%c${ART}`,
    'color:#b4552a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.15',
  );
  console.log(
    '%cThis site was built with Claude Opus 5.',
    'font-weight:700;font-size:13px',
  );
  console.log(
    '%cEvery line of the collector, the UI, and this greeting was written by Claude Opus 5 —\n' +
      'the digest you are reading is also picked and summarised by a model each morning.\n' +
      'Source: https://github.com/sasacheese/news-curator',
    'color:#6b6b64;line-height:1.6',
  );
}
