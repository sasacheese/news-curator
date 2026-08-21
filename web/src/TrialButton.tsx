import { useCallback, useEffect, useState } from 'react';
import { isFeedbackUnlocked } from './settings';
import {
  forgetLocalTrial,
  readLocalTrial,
  readTrialState,
  requestTrial,
  shouldForgetLocalTrial,
  trialKey,
  type TrialState,
  type TrialTarget,
} from './trial';
import type { TrialPlan } from './types';

/**
 * 自分で試す代わりに、サンドボックスで試させるボタン。
 *
 * **試せるものにだけ出る。** `deep.trial` が null の記事（GUI が本体、要ログイン、
 * 要課金、要 GPU、そもそも動かす対象が無い読み物）では collector 側で null に落ちる。
 * 全カードに出すと半分が失敗レポートになり、押す気がなくなるので、
 * 判定は「具体的なコマンドと問いが書けたか」に寄せてある。
 *
 * 置き場所は「試し方」の直下。読者が手順を読んで「面倒だな」と思った、まさにその場所に
 * 代わりの選択肢を置く——カード末尾のボタン列に混ぜると、この機能はほぼ見つからない。
 *
 * 押したあとに何が起きるかを必ず添える。裏で数十分かかるので、
 * 「押したのに何も起きない」に見えた時点でこの機能は死ぬ。
 */
export function TrialButton({
  plan,
  target,
  compact = false,
}: {
  plan: TrialPlan;
  target: TrialTarget;
  /**
   * 一覧の行の中に出すとき（その他候補・リリース情報・発掘）。
   * 問いを箱で開かず 1 行のボタンに畳む——一覧に本文級の箱が並ぶと一覧が読めない。
   * 何を確かめるのかは hover とタップ後の状態表示で伝える。
   */
  compact?: boolean;
}) {
  const key = trialKey(target.digestDate, target.itemId);
  const [state, setState] = useState<TrialState | null>(null);
  const [localAt, setLocalAt] = useState<number | null>(() => readLocalTrial(key));
  const [sending, setSending] = useState(false);

  /*
   * 開いたときと、ウィンドウに戻ってきたときに読む。
   * 「仕事に戻って、一服するときに開いたら結果が出ている」がこの機能の狙いなので、
   * 戻ってきた瞬間に最新であることがそのまま体験になる。常時ポーリングはしない。
   */
  const refresh = useCallback(() => {
    if (!localAt) return;
    void readTrialState(key).then((s) => {
      if (s === null) return; // 読めなかっただけ。控えは残す
      if (s === 'missing') {
        /*
         * 置き場から消えている。失敗した依頼を消して押し直したいときと、
         * 31 日の TTL で消えたときに来る。控えを持ち続けると「順番待ち」を
         * 永遠に出すことになるので、押していない状態へ戻す。
         *
         * 押した直後は、まだ書き込みが届いていないことがある（この端末の
         * 控えのほうが先）。数分は消さずに待つ。
         */
        if (shouldForgetLocalTrial(localAt)) {
          forgetLocalTrial(key);
          setLocalAt(null);
          setState(null);
        }
        return;
      }
      setState(s);
    });
  }, [key, localAt]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 合言葉で解除した端末だけ。押すと API 費用がかかるので、読み手には出さない
  if (!isFeedbackUnlocked()) return null;

  const send = () => {
    setSending(true);
    setLocalAt(Date.now());
    void requestTrial(target).finally(() => setSending(false));
  };

  const status = state?.status ?? (localAt ? 'queued' : null);

  if (compact) {
    if (status === null) {
      return (
        <button
          type="button"
          className="btn btn--sm trial__go trial__go--compact"
          disabled={sending}
          onClick={send}
          title={[
            'サンドボックスで試させて、結果をここに出します。確かめること:',
            ...plan.questions.map((q) => `・${q}`),
            `最初のコマンド: ${plan.install}`,
          ].join('\n')}
        >
          {sending ? '依頼しています…' : '🧪 試させる'}
        </button>
      );
    }
    return (
      <p className="trial__note trial__note--compact">
        {status === 'queued' && `⏳ 順番待ち（${requested(state?.requestedAt ?? localAt)}）`}
        {status === 'running' && `🧪 試しています（${requested(state?.requestedAt ?? localAt)}）`}
        {status === 'done' && `✓ ${state?.note ?? '試した結果が出ました。'}`}
        {status === 'failed' && `× ${state?.note ?? '試せませんでした。'}`}
      </p>
    );
  }

  return (
    <div className={`trial${status === 'done' ? ' trial--done' : ''}`}>
      <p className="trial__lead">
        {status ? '試させています' : '自分で試す代わりに、サンドボックスで試させる'}
      </p>

      {/*
        * 何を確かめさせるのかを先に見せる。「試させる」だけでは押す理由にならない——
        * 押す理由は、記事を読んでも分からないことが分かることの側にある。
        */}
      <ul className="trial__questions">
        {plan.questions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>

      {status === null && (
        <>
          <button type="button" className="btn btn--sm trial__go" disabled={sending} onClick={send}>
            {sending ? '依頼しています…' : '🧪 試させる'}
          </button>
          <p className="trial__note">
            素の Linux コンテナで <code>{plan.install}</code> から動かします。
            結果は 30 分ほどでこのカードに出ます（通知を許可していれば届きます）。
          </p>
        </>
      )}

      {status === 'queued' && (
        <p className="trial__note">
          ⏳ 順番待ちです（{requested(state?.requestedAt ?? localAt)}）。
          このページを閉じても進みます。
        </p>
      )}
      {status === 'running' && (
        <p className="trial__note">
          🧪 いま試しています（{requested(state?.requestedAt ?? localAt)}）。
        </p>
      )}
      {status === 'done' && (
        <p className="trial__note trial__note--done">✓ {state?.note ?? '試した結果が出ました。'}</p>
      )}
      {status === 'failed' && (
        <p className="trial__note trial__note--failed">
          × {state?.note ?? '試せませんでした。'}
        </p>
      )}
    </div>
  );
}

/**
 * 「3 分前に依頼」。分単位で足りる（この機能の時間感覚は分〜時間）。
 *
 * 相対時刻だけを返して呼び出し側で文を組むと、押した直後が「たった今に依頼」に
 * なってしまう。句ごと返す。
 */
function requested(at: number | null): string {
  if (!at) return 'さきほど依頼';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'いま依頼しました';
  if (minutes < 60) return `${minutes} 分前に依頼`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 時間前に依頼` : `${Math.floor(hours / 24)} 日前に依頼`;
}
