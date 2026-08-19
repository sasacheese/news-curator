import { log } from './util.js';

/**
 * firebase-admin は FIREBASE_SERVICE_ACCOUNT_JSON が無ければ読み込まない。
 * 未設定の環境（この機能を使わない fork など）でトップレベル import が
 * 失敗しないよう、動的 import にする。
 *
 * 読者フィードバックの集計（feedback.ts）とプッシュ通知の送信（send-push.ts）で共用する。
 */
export async function getAdminDb() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;

  try {
    const [{ cert, getApps, initializeApp }, { getFirestore, Timestamp }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const credentials = JSON.parse(json);
    const app = getApps()[0] ?? initializeApp({ credential: cert(credentials) });
    return { db: getFirestore(app), Timestamp };
  } catch (err) {
    log.warn(`Firebase 初期化に失敗しました: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
