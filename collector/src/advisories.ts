import type { ReleaseAdvisory, ReleaseItem } from './types.js';
import { fetchJson, hashId, log, truncate } from './util.js';

/**
 * GitHub Security Advisories から重大な脆弱性を拾う。
 *
 * リリース監視だけでは脆弱性が拾えない。実測（3 日・27 件）で、リリースノートに
 * セキュリティの言及は 0 件だった。GitHub では脆弱性はリリースノートではなく
 * Security Advisory として別に出るので、入口を分ける必要がある。
 *
 * 監視対象を増やしても解決しない問題なので、専用のソースにしている。
 */

const ENDPOINT = 'https://api.github.com/advisories';

export interface AdvisoryConfig {
  enabled: boolean;
  /**
   * 拾う深刻度。API が受けるのは unknown / low / medium / high / critical。
   * severity パラメータは 1 リクエストに 1 値しか渡せない（カンマ区切りは 422）ので、
   * ここに並べた値ごとにリクエストを分ける。
   */
  severities: string[];
  /** 対象エコシステム。npm / actions / pip / go / rubygems など */
  ecosystems: string[];
  /**
   * watchlist から名前を導けないパッケージを手で足す。
   * 例: TanStack/router → @tanstack/react-router のように名前がずれるもの。
   */
  extraPackages: string[];
  /** 1 エコシステムあたりの取得件数 */
  perPage: number;
}

interface RawAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  description?: string | null;
  severity: string;
  published_at: string;
  html_url: string;
  /** 旧形式。CVSS v4 に移った advisory では score が null になる */
  cvss?: { score: number | null } | null;
  cvss_severities?: {
    cvss_v3?: { score: number | null } | null;
    cvss_v4?: { score: number | null } | null;
  } | null;
  vulnerabilities?:
    | {
        package?: { ecosystem?: string | null; name?: string | null } | null;
        first_patched_version?: string | null;
      }[]
    | null;
}

/**
 * 監視対象リポジトリからパッケージ名の候補を作る。
 *
 * `facebook/react` → `react`、`@facebook/react`、スコープ `facebook`。
 * リポジトリ名とパッケージ名は一致しないことが多いので（TanStack/router の
 * 実体は @tanstack/react-router）、スコープでの照合と extraPackages で補う。
 */
export function packageMatcher(
  repos: readonly string[],
  extraPackages: readonly string[],
): (packageName: string) => boolean {
  const names = new Set<string>();
  const scopes = new Set<string>();

  for (const repo of repos) {
    const [owner, name] = repo.toLowerCase().split('/');
    if (!owner || !name) continue;
    names.add(name);
    names.add(`@${owner}/${name}`);
    scopes.add(owner);
  }
  for (const p of extraPackages) names.add(p.toLowerCase());

  return (packageName: string): boolean => {
    const n = packageName.trim().toLowerCase();
    if (!n) return false;
    if (names.has(n)) return true;
    // スコープ付きは「スコープが監視対象の owner」または「名前部分が一致」で拾う
    const scoped = /^@([^/]+)\/(.+)$/.exec(n);
    if (scoped) {
      const [, scope, rest] = scoped;
      if (scope && scopes.has(scope)) return true;
      if (rest && names.has(rest)) return true;
    }
    return false;
  };
}

/**
 * CVSS スコアを取り出す。
 *
 * 新しい advisory は CVSS v4 に移っていて、旧 `cvss.score` は null のまま
 * `cvss_severities.cvss_v4.score` に入る（実測: GHSA-gcfj-64vw-6mp9 が
 * cvss.score=null / cvss_v4.score=8.3）。0 は「未採点」の意味なので捨てる。
 */
function pickCvss(a: RawAdvisory): number | null {
  const candidates = [
    a.cvss_severities?.cvss_v4?.score,
    a.cvss_severities?.cvss_v3?.score,
    a.cvss?.score,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return c;
  }
  return null;
}

function toSeverity(v: string): ReleaseAdvisory['severity'] {
  const s = v.toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  // API は unknown を返すことがある。低い側に寄せる
  return 'medium';
}

/**
 * 1 件の advisory を、影響パッケージのうち監視対象に当たるものだけに絞って変換する。
 * 1 つの advisory が複数パッケージに影響することがあるので、最初に当たったものを代表にする。
 */
function toReleaseItem(a: RawAdvisory, matches: (name: string) => boolean): ReleaseItem | null {
  const hit = (a.vulnerabilities ?? []).find((v) => matches(v.package?.name ?? ''));
  if (!hit) return null;
  const packageName = hit.package?.name ?? '';
  const severity = toSeverity(a.severity);

  const advisory: ReleaseAdvisory = {
    cveId: a.cve_id ?? null,
    ghsaId: a.ghsa_id,
    severity,
    cvss: pickCvss(a),
    packageName,
    patchedVersion: hit.first_patched_version ?? null,
  };

  const patched = advisory.patchedVersion;
  return {
    id: hashId('advisory', a.ghsa_id, packageName),
    product: packageName,
    what: null,
    version: patched,
    // 仕様上の分類としては修正リリース。並べる軸は impact 側で security にする
    kind: 'patch',
    impact: 'security',
    unlock: patched
      ? `${patched} 以降に上げると塞がる`
      : '修正版がまだ無い（回避策の確認が必要）',
    change: null,
    scope: [],
    advisory,
    summary: truncate(a.summary.replace(/\s+/g, ' ').trim(), 160),
    title: a.summary,
    url: a.html_url,
    sourceLabel: 'GitHub Security Advisory',
    publishedAt: a.published_at,
    alsoReleased: [],
  };
}

/**
 * ウィンドウ内に公開された advisory のうち、監視対象のパッケージに当たるものを返す。
 *
 * 落とした件数もログに出す。監視対象からパッケージ名を導けないもの（TanStack など）が
 * あるので、取りこぼしているなら extraPackages に足せると分かるようにしておく。
 */
export async function collectAdvisories(
  cfg: AdvisoryConfig,
  repos: readonly string[],
  window: { start: Date; end: Date },
  token?: string,
): Promise<ReleaseItem[]> {
  if (!cfg.enabled) return [];

  const matches = packageMatcher(repos, cfg.extraPackages);
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const seen = new Set<string>();
  const out: ReleaseItem[] = [];
  let fetched = 0;

  // エコシステム × 深刻度。既定なら 4 × 2 = 8 リクエスト（未認証の 60/時 に収まる）
  for (const ecosystem of cfg.ecosystems) {
    for (const severity of cfg.severities) {
      const url =
        `${ENDPOINT}?type=reviewed&severity=${encodeURIComponent(severity)}` +
        `&ecosystem=${encodeURIComponent(ecosystem)}&per_page=${cfg.perPage}` +
        `&sort=published&direction=desc`;

      let list: RawAdvisory[];
      try {
        list = await fetchJson<RawAdvisory[]>(url, { headers });
      } catch (err) {
        log.warn(`advisories(${ecosystem}/${severity}): ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!Array.isArray(list)) continue;
      fetched += list.length;

      for (const a of list) {
        const at = new Date(a.published_at).getTime();
        if (Number.isNaN(at) || at < window.start.getTime() || at >= window.end.getTime()) continue;
        if (seen.has(a.ghsa_id)) continue;
        const item = toReleaseItem(a, matches);
        if (!item) continue;
        seen.add(a.ghsa_id);
        out.push(item);
      }
    }
  }

  log.info(
    `  脆弱性: ${out.length} 件（取得 ${fetched} 件から、監視対象のパッケージに当たるものだけ）`,
  );
  return out;
}
