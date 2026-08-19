/**
 * プッシュ通知の受信専用 Service Worker。
 *
 * fetch ハンドラは意図的に持たない。オフラインキャッシュを始めると
 * 「デプロイしたのに古い画面が出る」問題を背負うことになり、
 * 毎朝差し替わるサイトとは相性が悪い。ここでは通知の表示とタップだけを担う。
 *
 * 収集側（collector/src/send-push.ts）が送る payload:
 *   { title: string, body: string, url: string | null, tag: string }
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // JSON でない payload はテスト送信くらいなので、本文にそのまま出す
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Tech Digest';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '今朝のダイジェストができました。',
      // SW と同じディレクトリに置いてあるので相対で解決できる
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // 同じ tag は上書きされる。再実行した朝に通知が 2 つ並ばないように
      tag: payload.tag || 'daily-digest',
      data: { url: payload.url || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;

  event.waitUntil(
    (async () => {
      // 既にサイトを開いているウィンドウ（PWA 含む）があればそれを前に出す
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of windows) {
        if (win.url.startsWith(self.registration.scope) && 'focus' in win) {
          await win.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
