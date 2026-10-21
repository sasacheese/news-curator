import { getAdminDb } from './firebaseAdmin.js';
import type { ToolCandidate, ToolStateUpdate } from './tools.js';
import { identityFromUrl } from './try-prompt.js';
import type { PassReason, ToolIdentity, ToolState } from './types.js';
import { fetchJson, log, truncate } from './util.js';

/* ------------------------------------------------------------------ *
 * 読者の操作（Firestore）を読む
 *
 * - toolInbox/{id}  : 道具箱の「URL を貼って追加」。{ url, createdAt }
 * - toolState/{id}  : 気になる・見送り・触った。{ state, reason, updatedAt }。ID は道具の ID
 *
 * どちらもブラウザから書き、読むのは collector だけ（Security Rules で read を閉じる）。
 * FIREBASE_SERVICE_ACCOUNT_JSON が無ければ何もしない。
 * ------------------------------------------------------------------ */

/** 1 回に処理する受付の上限。ルールで書き込みを絞れないので、ここで量を抑える */
const INBOX_LIMIT = 30;

export interface InboxEntry {
  docId: string;
  url: string;
}

/** 貼られた URL のうち、取りに行ってよいもの。https の公開ホストだけ */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IP 直打ちは取りに行かない（道具の URL は名前で配られる）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
  return true;
}

export async function loadInbox(): Promise<InboxEntry[]> {
  const admin = await getAdminDb();
  if (!admin) return [];
  const snap = await admin.db.collection('toolInbox').limit(INBOX_LIMIT).get();
  return snap.docs.flatMap((d) => {
    const url = d.get('url');
    return typeof url === 'string' ? [{ docId: d.id, url: url.trim() }] : [];
  });
}

export async function clearInbox(docIds: readonly string[]): Promise<void> {
  if (docIds.length === 0) return;
  const admin = await getAdminDb();
  if (!admin) return;
  const batch = admin.db.batch();
  for (const id of docIds) batch.delete(admin.db.collection('toolInbox').doc(id));
  await batch.commit();
}

export async function loadToolStates(): Promise<ToolStateUpdate[]> {
  const admin = await getAdminDb();
  if (!admin) return [];
  const snap = await admin.db.collection('toolState').get();
  return snap.docs.flatMap((d) => {
    const state = d.get('state') as ToolState | undefined;
    const at = d.get('updatedAt');
    const iso =
      at && typeof at.toDate === 'function' ? (at.toDate() as Date).toISOString() : new Date().toISOString();
    // ドキュメント ID に使えない「/」は「|」に置き換えて保存している（web/src/toolbox.ts と対）
    const id = d.id.replace(/\|/g, '/');
    return state ? [{ id, state, reason: (d.get('reason') as PassReason | null) ?? null, at: iso }] : [];
  });
}

/* ---------- URL から道具を割り出す ---------- */

function isXStatus(url: URL): boolean {
  return /(^|\.)(x|twitter)\.com$/.test(url.hostname) && /\/status\/\d+/.test(url.pathname);
}

/** oEmbed の HTML から本文中のリンクを抜く（t.co の短縮リンクは後で展開する） */
export function linksFromOembedHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1]!.replace(/&amp;/g, '&');
    // 投稿そのものへのリンク（日付の部分）とハッシュタグ・メンションは道具ではない
    if (/(^|\/\/)(www\.)?(x|twitter)\.com\//.test(href)) continue;
    out.push(href);
  }
  return out;
}

async function expand(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return res.url || url;
  } catch {
    return url;
  }
}

function toIdentity(url: string): ToolIdentity | null {
  const id = identityFromUrl(url);
  if (id?.githubRepo) return { github: id.githubRepo };
  if (id?.npmPackage) return { npm: id.npmPackage };
  return null;
}

async function pageTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    const html = (await res.text()).slice(0, 200_000);
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
    const title = og ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
    return title ? truncate(title.replace(/\s+/g, ' ').trim(), 80) : null;
  } catch {
    return null;
  }
}

/**
 * 貼られた URL を道具の候補にする。
 *
 * X の投稿は API を使わず oEmbed（publish.twitter.com）で本文の HTML を取り、
 * その中のリンクを展開して GitHub / npm を探す。見つからなければ最初のリンクを
 * サービスの URL とみなす。リンクの無い投稿は、投稿そのものを URL として登録する
 * （画面で「未解決」と分かるように、名前に投稿者を入れる）。
 */
export async function resolveInboxUrl(raw: string, date: string): Promise<ToolCandidate | null> {
  if (!isSafePublicUrl(raw)) return null;
  const url = new URL(raw);
  const signal = { source: 'manual', date, strength: 2, url: raw };

  if (isXStatus(url)) {
    const embed = await fetchJson<{ html?: string; author_name?: string }>(
      `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(raw)}`,
    ).catch(() => null);
    const text = embed?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
    const links = await Promise.all(linksFromOembedHtml(embed?.html ?? '').map(expand));
    const safeLinks = links.filter(isSafePublicUrl);
    const withIdentity = safeLinks.map((l) => ({ l, id: toIdentity(l) })).find((x) => x.id);
    const note = truncate(text, 200) || undefined;
    if (withIdentity?.id) {
      return fromIdentity(withIdentity.id, withIdentity.l, { ...signal, note, title: embed?.author_name });
    }
    const first = safeLinks[0];
    if (first) {
      return {
        identity: { url: first },
        name: (await pageTitle(first)) ?? new URL(first).hostname,
        homepage: first,
        description: note ?? null,
        signal: { ...signal, note, title: embed?.author_name },
      };
    }
    return {
      identity: { url: raw },
      name: `未解決: ${embed?.author_name ?? 'X'} の投稿`,
      homepage: raw,
      description: note ?? null,
      signal: { ...signal, note },
    };
  }

  const identity = toIdentity(raw);
  if (identity) return fromIdentity(identity, raw, signal);
  return {
    identity: { url: raw },
    name: (await pageTitle(raw)) ?? url.hostname,
    homepage: raw,
    signal,
  };
}

function fromIdentity(identity: ToolIdentity, url: string, signal: ToolCandidate['signal']): ToolCandidate {
  const homepage = identity.github
    ? `https://github.com/${identity.github}`
    : identity.npm
      ? `https://www.npmjs.com/package/${identity.npm}`
      : url;
  const name = identity.github?.split('/')[1] ?? identity.npm ?? url;
  return { identity, name, homepage, signal };
}

export function logInbox(n: number, resolved: number): void {
  if (n > 0) log.info(`  [道具] 手で追加: ${resolved}/${n} 件`);
}
