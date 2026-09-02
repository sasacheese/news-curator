import { getAdminDb } from './firebaseAdmin.js';
import { log } from './util.js';

/**
 * 購読中の全端末へ Web Push を送る。
 *
 * 送り先の解決と失効した購読の掃除をここに寄せてある。呼び出し側が持つのは
 * payload だけ——送信の手順を呼び出し側ごとに持つと、片方だけ失効した購読を
 * 消し続けることになる。
 *
 * VAPID 鍵か Firebase の設定が無ければ黙って何もしない（この機能を使っていない
 * fork でもワークフローを落とさない）。個々の端末への送信失敗もジョブを落とさず、
 * 失効した購読（404/410）だけ Firestore から掃除する。
 */

export interface PushPayload {
  title: string;
  body: string;
  /** タップ先。null なら Service Worker がスコープ直下を開く */
  url: string | null;
  /**
   * 同じ tag の通知は端末上で置き換わる。用途が違う通知には別の tag を使う
   * ——同じにすると、朝のダイジェストの通知が別の通知で消える。
   */
  tag: string;
  /** 秒。この時間内に届かなければ捨てさせる */
  ttlSeconds: number;
}

/** 購読 1 件。ドキュメント ID は endpoint の SHA-256（web/src/push.ts が採番する） */
interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const SEND_CONCURRENCY = 20;

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    log.info('VAPID 鍵が無いため、プッシュ通知はスキップします');
    return;
  }

  const admin = await getAdminDb();
  if (!admin) {
    log.info('Firebase の設定が無いため、プッシュ通知はスキップします');
    return;
  }

  const snap = await admin.db.collection('pushSubscriptions').get();
  if (snap.empty) {
    log.info('プッシュ通知: 購読している端末がありません');
    return;
  }

  // VAPID の subject は連絡先の表明。メールでなくてもサイト URL で仕様を満たす
  const subject = process.env.VAPID_SUBJECT || payload.url || 'https://github.com';
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(subject, publicKey, privateKey);

  let sent = 0;
  let expired = 0;
  let failed = 0;

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      docs.slice(i, i + SEND_CONCURRENCY).map(async (doc) => {
        const d = doc.data() as Partial<StoredSubscription>;
        if (!d.endpoint || !d.p256dh || !d.auth) {
          // ルールの検証を通らない形は本来入らないが、消せる根拠にはなる
          await doc.ref.delete();
          expired++;
          return;
        }
        try {
          await webpush.sendNotification(
            { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
            JSON.stringify({
              title: payload.title,
              body: payload.body,
              url: payload.url,
              tag: payload.tag,
            }),
            { TTL: payload.ttlSeconds, urgency: 'normal' },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // 購読が失効している（アプリ削除・許可取り消しなど）。貯めても戻らないので消す
            await doc.ref.delete();
            expired++;
          } else {
            failed++;
            log.warn(
              `プッシュ通知の送信に失敗しました (HTTP ${status ?? '?'}): ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }),
    );
  }

  log.info(`プッシュ通知: ${sent} 件送信 / ${expired} 件失効を削除 / ${failed} 件失敗`);
}

/** 通知のタップ先。manifest の repo から GitHub Pages の URL を組む */
export function siteUrl(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return owner && name ? `https://${owner}.github.io/${name}/` : null;
}
