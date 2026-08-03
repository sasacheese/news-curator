import type { FirebaseApp } from 'firebase/app';
import type { Firestore } from 'firebase/firestore/lite';

/**
 * Firebase SDK は動的 import で遅延読み込みする。
 *
 * フィードバック機能を解除していない訪問者（ほとんど全員）はこのモジュールの
 * 中身を一切ダウンロードしなくて済む。設定が無い環境（VITE_FIREBASE_* 未設定）でも
 * import 自体は起きない。
 */
let dbPromise: Promise<Firestore | null> | null = null;

export function getFeedbackDb(): Promise<Firestore | null> {
  if (!dbPromise) dbPromise = load();
  return dbPromise;
}

async function load(): Promise<Firestore | null> {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !projectId) return null;

  const [{ initializeApp }, { getFirestore }] = await Promise.all([
    import('firebase/app'),
    import('firebase/firestore/lite'),
  ]);
  const app: FirebaseApp = initializeApp({ apiKey, projectId, appId });
  return getFirestore(app);
}
