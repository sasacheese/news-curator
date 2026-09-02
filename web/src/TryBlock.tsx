import { useState } from 'react';
import { CopyButton } from './components';
import { TRY_EXITS, canOpenExits } from './tryPrompt';

/**
 * 貼れるプロンプトと、開く先。
 *
 * プロンプトは畳まずに見せる。読み物としても成立する文（目標・手順・確認したいこと・
 * 前提）なので、スマホで読んで理解する用途をそのまま満たす。隠すと「試し方」の
 * 中身が見えないカードになる。
 *
 * 開く先は PC でだけ出す。押した時点でクリップボードにも入れるのは、Claude Code 以外は
 * 開いた先に貼るしかないから——URL でプロンプトを渡せるクラウド環境は無かった。
 *
 * `compact` は一覧の行（その他候補・リリース・発掘）向け。1 行の見出しに畳んで、
 * 開いたときだけ本文と開く先を出す。一覧に本文級の箱が並ぶと一覧が読めない。
 */
export function TryBlock({ prompt, compact = false }: { prompt: string; compact?: boolean }) {
  const [exits] = useState(canOpenExits);

  const copy = () => {
    navigator.clipboard?.writeText(prompt).catch(() => undefined);
  };

  const body = (
    <div className="try">
      <pre className="try__prompt">{prompt}</pre>
      <div className="try__actions">
        <CopyButton text={prompt} label="プロンプトをコピー" />
        {exits &&
          TRY_EXITS.map((exit) => (
            <a
              key={exit.key}
              className={`btn btn--sm try__exit${exit.carriesPrompt ? ' try__exit--carries' : ''}`}
              href={exit.href(prompt)}
              title={exit.title}
              onClick={copy}
              // ディープリンクは同じタブに渡す（別タブにすると空のタブが残る）
              {...(exit.carriesPrompt ? {} : { target: '_blank', rel: 'noreferrer noopener' })}
            >
              {exit.label}
            </a>
          ))}
      </div>
      {exits && (
        <p className="try__hint">
          Claude Code はプロンプトが入った状態で開きます。ほかは開いたあとに貼ってください
          （どれを押してもクリップボードに入ります）。
        </p>
      )}
    </div>
  );

  if (!compact) return body;

  return (
    <details className="try--compact">
      <summary className="try__summary">⎘ 試すプロンプト</summary>
      {body}
    </details>
  );
}
