import { getFeedbackDb } from './firebase';

/**
 * 毎朝のプッシュ通知の購読管理。
 *
 * 購読情報（endpoint と暗号鍵）は Firestore の `pushSubscriptions` に保存し、
 * 毎朝の GitHub Actions が web-push で全端末へ送る。フィードバックと同じく
 * 「クライアントから直接書き、アクセス制御は Security Rules が担う」方式。
 *
 * ドキュメント ID は endpoint の SHA-256。endpoint はブラウザが発行する
 * 推測不能な URL なので、この ID を知っているのは購読した本人の端末だけになる。
 * ルール側で read/list を全部閉じたうえで、delete だけは「ID を知っている＝本人」
 * とみなして許している（解除をサーバー無しで成立させるため）。
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const COLLECTION = 'pushSubscriptions';

/** ビルドに購読へ必要な設定（VAPID 公開鍵と Firebase）が揃っているか */
export function hasPushConfig(): boolean {
  return Boolean(
    VAPID_PUBLIC_KEY &&
      import.meta.env.VITE_FIREBASE_PUBLIC_API_KEY &&
      import.meta.env.VITE_FIREBASE_PUBLIC_PROJECT_ID,
  );
}

function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iPadOS が Mac を名乗るので、タッチ点数も見る */
function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1)
  );
}

/** ホーム画面に追加した PWA として起動しているか */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export type PushStatus =
  /** この端末で購読済み（毎朝届く） */
  | 'subscribed'
  /** 購読できるが、まだしていない */
  | 'ready'
  /** ユーザーが通知をブロックしている。ブラウザの設定からしか戻せない */
  | 'denied'
  /** iOS のブラウザ起動。ホーム画面に追加すれば使えるようになる */
  | 'needs-install'
  /** このブラウザでは使えない */
  | 'unsupported';

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) {
    // iOS Safari は PWA として起動したときだけ Push API を生やす
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';

  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'subscribed' : 'ready';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function subscriptionDocId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 通知許可を取り、購読して Firestore に保存する。
 * ユーザー操作（ボタン押下）から呼ぶこと。iOS は操作起点でないと許可ダイアログを出さない。
 */
export async function subscribePush(): Promise<void> {
  if (!VAPID_PUBLIC_KEY) throw new Error('VAPID 公開鍵がビルドに入っていません');

  const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした');

  const sub = await reg.pushManager.subscribe({
    // 「受け取ったら必ず通知を見せる」の宣言。サイレントプッシュは使わない
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const db = await getFeedbackDb();
  if (!db) {
    await sub.unsubscribe();
    throw new Error('Firebase の設定が無いため、購読を保存できません');
  }

  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) {
    await sub.unsubscribe();
    throw new Error('ブラウザが購読の暗号鍵を返しませんでした');
  }

  try {
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore/lite');
    await setDoc(doc(db, COLLECTION, await subscriptionDocId(sub.endpoint)), {
      endpoint: sub.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    // 保存できなかった購読は誰からも送信されない。残すと「届かないのに購読済み」になる
    await sub.unsubscribe();
    throw err;
  }
}

/** 購読を解除し、Firestore からも消す */
export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;

  const docId = await subscriptionDocId(sub.endpoint);
  await sub.unsubscribe();

  try {
    const db = await getFeedbackDb();
    if (!db) return;
    const { deleteDoc, doc } = await import('firebase/firestore/lite');
    await deleteDoc(doc(db, COLLECTION, docId));
  } catch (err) {
    // 端末側の解除は済んでいる。ドキュメントが残っても次回送信の 410 掃除で消える
    console.warn('購読情報の削除に失敗しました', err);
  }
}
