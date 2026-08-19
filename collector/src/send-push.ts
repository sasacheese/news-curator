import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { getAdminDb } from './firebaseAdmin.js';
import type { Digest, Manifest } from './types.js';
import { log } from './util.js';

/**
 * 当日のダイジェスト完成後に、購読中の全端末へ Web Push を送る。
 *
 * ワークフローでは Pages のデプロイ**後**に実行する。通知を先に出すと、
 * タップした先がまだ前日のままということが起きる。
 *
 * VAPID 鍵か Firebase の設定が無ければ黙って何もしない（この機能を
 * 使っていない fork でもワークフローを落とさない）。個々の端末への
 * 送信失敗もジョブを落とさず、購読が失効した端末（404/410）だけ
 * Firestore から掃除する。
 */

/** 購読 1 件。ドキュメント ID は endpoint の SHA-256（web/src/push.ts が採番する） */
interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const SEND_CONCURRENCY = 20;

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 通知の本文。ダイジェストが読めない日でも通知自体は出す */
function buildPayload(manifest: Manifest | null, digest: Digest | null) {
  const date = digest?.date ?? manifest?.latest ?? null;
  const title = date ? `${date} のダイジェスト` : '今朝のダイジェスト';

  let body = '今朝のダイジェストができました。';
  if (digest) {
    const minutes = digest.stats.estimatedReadMinutes;
    const parts = [
      `深掘り ${digest.top.length} 本`,
      `リリース ${digest.releases.length} 件`,
      `その他 ${digest.others.length} 件`,
    ];
    body = `${parts.join('・')}。読了目安 約 ${minutes} 分。`;
  }

  // 通知のタップ先。リポジトリ名が取れない環境では SW がスコープ直下を開く
  const repo = manifest?.repo ?? null;
  const url = repo ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/` : null;

  return { title, body, url, tag: 'daily-digest' };
}

async function main(): Promise<void> {
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

  const manifest = await readJsonOrNull<Manifest>(resolve(DATA_DIR, 'manifest.json'));
  const digest = manifest?.latest
    ? await readJsonOrNull<Digest>(resolve(DATA_DIR, 'digests', `${manifest.latest}.json`))
    : null;
  const payload = buildPayload(manifest, digest);

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
            JSON.stringify(payload),
            // 朝のうちに届かなければ価値が無いので、半日で破棄させる
            { TTL: 12 * 3600, urgency: 'normal' },
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

await main();
