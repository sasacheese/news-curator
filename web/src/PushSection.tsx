import { useEffect, useState } from 'react';
import { type PushStatus, getPushStatus, subscribePush, unsubscribePush } from './push';

/**
 * 設定画面の「毎朝のプッシュ通知」セクション。
 *
 * 購読は端末（正確にはブラウザプロファイル）ごと。localStorage の設定類と
 * 同じく、iOS ではホーム画面に追加した PWA と Safari が別々の環境になる。
 */
export function PushSection() {
  const [status, setStatus] = useState<PushStatus | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPushStatus().then(
      (s) => {
        if (!cancelled) setStatus(s);
      },
      () => {
        if (!cancelled) setStatus('unsupported');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await getPushStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 許可ダイアログで「ブロック」を選んだ直後などに状態表示も追従させる
      setStatus(await getPushStatus().catch(() => 'unsupported' as const));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>毎朝のプッシュ通知</h2>
      <p>
        毎朝のダイジェスト完成後（8:00 ごろ）に、この端末へ通知を送ります。
        購読は端末ごとです。届けたい端末それぞれでこの画面から購読してください。
      </p>

      {status === 'loading' && <p className="field__hint">状態を確認しています…</p>}

      {status === 'needs-install' && (
        <p className="field__hint">
          iOS では、共有メニューから<strong>「ホーム画面に追加」</strong>したアプリの中でだけ
          通知を購読できます（iOS 16.4 以降）。追加してから、そのアプリでこの画面を
          もう一度開いてください。
        </p>
      )}

      {status === 'unsupported' && (
        <p className="field__hint">このブラウザはプッシュ通知に対応していません。</p>
      )}

      {status === 'denied' && (
        <p className="field__hint">
          このサイトの通知がブロックされています。ブラウザ（または OS）のサイト設定で
          通知を許可し直すと、ここから購読できるようになります。
        </p>
      )}

      {status === 'ready' && (
        <div className="actions" style={{ marginTop: 0 }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void run(subscribePush)}
          >
            {busy ? '購読しています…' : 'この端末で受け取る'}
          </button>
        </div>
      )}

      {status === 'subscribed' && (
        <div className="actions" style={{ marginTop: 0 }}>
          <span className="field__hint" style={{ margin: 0 }}>
            この端末は購読済みです。毎朝届きます。
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => void run(unsubscribePush)}
          >
            {busy ? '解除しています…' : '購読を解除する'}
          </button>
        </div>
      )}

      {error && (
        <p className="field__hint" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </section>
  );
}
