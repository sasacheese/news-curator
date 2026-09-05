import { useState } from 'react';
import { CopyButton } from './components';
import { MOBILE_EXIT, TRY_EXITS, detectDevice, type TryExit } from './tryPrompt';

/**
 * 貼れるプロンプトと、開く先。
 *
 * プロンプトは畳まずに見せる。読み物としても成立する文（目標・手順・確認したいこと・
 * 前提）なので、スマホで読んで理解する用途をそのまま満たす。隠すと「試し方」の
 * 中身が見えないカードになる。
 *
 * 開く先は端末で変える。PC は Claude Desktop とクラウド環境の列、スマホは
 * Claude アプリを開くボタンだけ。押した時点でクリップボードにも入れるのは、
 * クラウド環境は開いた先に貼るしかないから——URL でプロンプトを渡せるクラウド環境は
 * 無かった。
 *
 * `compact` は一覧の行（その他候補・リリース・発掘）向け。1 行の見出しに畳んで、
 * 開いたときだけ本文と開く先を出す。一覧に本文級の箱が並ぶと一覧が読めない。
 */
export function TryBlock({ prompt, compact = false }: { prompt: string; compact?: boolean }) {
  const [device] = useState(detectDevice);
  const exits: readonly TryExit[] = device === 'desktop' ? TRY_EXITS : [MOBILE_EXIT];

  const copy = () => {
    navigator.clipboard?.writeText(prompt).catch(() => undefined);
  };

  const body = (
    <div className="try">
      <pre className="try__prompt">{prompt}</pre>
      <div className="try__actions">
        <CopyButton text={prompt} label="プロンプトをコピー" />
        {exits.map((exit) => (
          <a
            key={exit.key}
            className={`btn btn--sm try__exit${exit.carriesPrompt ? ' try__exit--carries' : ''}`}
            href={exit.href(prompt)}
            title={exit.title}
            onClick={copy}
            /*
             * `claude://` は同じタブに渡す（別タブにすると空のタブが残る）。
             * https のリンクは別タブ。スマホの Universal Link はアプリに渡るので、
             * タブは開いてもすぐ戻る。
             */
            {...(exit.href(prompt).startsWith('claude://')
              ? {}
              : { target: '_blank', rel: 'noreferrer noopener' })}
          >
            {exit.label}
          </a>
        ))}
      </div>
      <p className="try__hint">
        {device === 'desktop'
          ? 'Claude Code は Claude Desktop にプロンプトが入った状態で開きます。ほかは開いたあとに貼ってください（どれを押してもクリップボードに入ります）。'
          : 'Claude アプリの Code タブにプロンプトが入った状態で開きます（クリップボードにも入ります）。'}
      </p>
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
