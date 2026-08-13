import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAskPrompt, claudeNewChatUrl, type AskContext } from './askClaude';

/**
 * 読んだ記事の文脈を載せた Claude の会話を開くボタン。
 *
 * `<a target="_blank">` にしているのは、window.open だとポップアップブロックに
 * かかることがあるのと、モバイルで Universal Link がアプリに渡るのは素の
 * ナビゲーションだけだから。
 *
 * 押したときにプロンプトをクリップボードにも入れている。claude.ai のリンクは
 * デスクトップアプリでは開けず Web 版になるので、アプリで続けたい場合に
 * 貼れる先を残しておく必要がある。URL 長で節を落とした場合も、こちらには
 * 全文が入る。
 */
export function AskClaudeButton({ context }: { context: AskContext }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // URL に載せる分は節を落とすことがあるが、クリップボードには長さの制約が無い
  const prompt = useMemo(() => buildAskPrompt(context), [context]);
  const fullPrompt = useMemo(() => buildAskPrompt(context, Infinity), [context]);

  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(fullPrompt).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };

  return (
    <a
      className="btn btn--sm ask-claude"
      href={claudeNewChatUrl(prompt)}
      target="_blank"
      rel="noreferrer noopener"
      title={
        'この記事の要約・前提知識を渡した状態で Claude との会話を開きます。' +
        'アプリが入っていればアプリで開きます。' +
        '同じ内容をクリップボードにも入れるので、デスクトップアプリに貼っても使えます。'
      }
      onClick={copy}
    >
      {copied ? '✓ コピーしました' : '✳ Claude に聞く'}
    </a>
  );
}
