import type { ToolCandidate } from './tools.js';
import { identityFromUrl } from './try-prompt.js';
import type { Digest, RadarBoard, RawItem, ToolIdentity } from './types.js';

/* ------------------------------------------------------------------ *
 * 入口A: いつもの収集から道具を拾う（追加の取得も LLM も無し）
 *
 * 身元（GitHub リポジトリ / npm パッケージ）が URL から取れるものだけを道具とみなす。
 * Qiita・Zenn の記事は道具の紹介であっても記事そのものは道具ではないので拾わない
 * （記事の中のリンクまで追うと、紹介されている道具より関係の無いリンクのほうが多い）。
 * 例外は Show HN で、これは「作ったものを見せる」場なので、URL が GitHub でなくても
 * その URL を道具の身元にする。
 * ------------------------------------------------------------------ */

function toIdentity(url: string): ToolIdentity | null {
  const id = identityFromUrl(url);
  if (id?.githubRepo) return { github: id.githubRepo };
  if (id?.npmPackage) return { npm: id.npmPackage };
  return null;
}

function homepageOf(identity: ToolIdentity, fallback: string): string {
  if (identity.github) return `https://github.com/${identity.github}`;
  if (identity.npm) return `https://www.npmjs.com/package/${identity.npm}`;
  return fallback;
}

function nameOf(identity: ToolIdentity, fallback: string): string {
  if (identity.github) return identity.github.split('/')[1] ?? fallback;
  if (identity.npm) return identity.npm;
  return fallback;
}

/** "Show HN: Foo – a fast bar" → "Foo" */
export function showHnName(title: string): string | null {
  const m = /^show hn:\s*(.+)$/i.exec(title.trim());
  if (!m) return null;
  const head = m[1]!.split(/\s[-–—:|]\s|[,:]\s/)[0]!.trim();
  return head.length > 0 && head.length <= 60 ? head : null;
}

export function candidatesFromDigest(digest: Digest): ToolCandidate[] {
  const out: ToolCandidate[] = [];
  const push = (url: string, title: string, source: string, strength: number, note?: string) => {
    const identity = toIdentity(url);
    if (!identity) return;
    out.push({
      identity,
      name: nameOf(identity, title),
      homepage: homepageOf(identity, url),
      signal: { source, date: digest.date, strength, title, url, note },
    });
  };
  for (const t of digest.top) push(t.url, t.titleJa ?? t.title, `digest:top:${t.lane}`, 1.2, t.oneLiner);
  for (const o of digest.others) push(o.url, o.titleJa ?? o.title, `digest:other:${o.lane}`, 0.8, o.oneLiner);
  for (const r of digest.releases ?? []) {
    // リリースは既存の道具の更新なので、新規の入口としては弱め。再浮上の信号としては効く
    push(r.url, r.title, 'release', 0.5, r.unlock ?? r.what ?? undefined);
  }
  return out;
}

export function candidatesFromCollected(items: readonly RawItem[], date: string): ToolCandidate[] {
  const out: ToolCandidate[] = [];
  for (const item of items) {
    if (item.source === 'github_repo') {
      const identity = toIdentity(item.url);
      if (!identity) continue;
      out.push({
        identity,
        name: nameOf(identity, item.title),
        homepage: homepageOf(identity, item.url),
        description: item.snippet,
        trust: { stars: item.metrics.stars ?? null },
        signal: { source: 'gh-trending', date, strength: 0.6, title: item.title, url: item.url },
      });
      continue;
    }
    if (item.source === 'hackernews') {
      const name = showHnName(item.title);
      if (!name) continue;
      const identity = toIdentity(item.url) ?? { url: item.url };
      out.push({
        identity,
        name: identity.url ? name : nameOf(identity, name),
        homepage: homepageOf(identity, item.url),
        kindHint: identity.url ? 'saas' : undefined,
        description: item.snippet || null,
        signal: { source: 'show-hn', date, strength: 0.7, title: item.title, url: item.url },
      });
    }
  }
  return out;
}

export function candidatesFromRadar(board: RadarBoard | null | undefined, date: string): ToolCandidate[] {
  if (!board) return [];
  const out: ToolCandidate[] = [];
  for (const item of board.items) {
    const identity: ToolIdentity = {};
    if (item.measure.githubRepo) identity.github = item.measure.githubRepo;
    if (item.measure.npmPackage) identity.npm = item.measure.npmPackage;
    if (!identity.github && !identity.npm) continue;
    out.push({
      identity,
      name: item.name,
      homepage: homepageOf(identity, item.links[0]?.url ?? ''),
      description: item.what,
      trust: { stars: item.measure.githubStars, archived: item.measure.githubArchived },
      // 発掘は「海外で先行・国内で薄い」を測った結果なので、入口としては強い
      signal: {
        source: 'radar',
        date,
        strength: 1,
        title: item.pitch,
        note: item.evidence[0],
      },
    });
  }
  return out;
}
