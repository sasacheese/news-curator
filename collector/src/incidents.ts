/**
 * セキュリティ事案の名寄せ。
 *
 * 同じ漏洩事案は、被害組織の発表・国内メディア・海外メディアが数日にわたって書く。
 * 記事単位で並べると同じ話が 3 枚のカードになり、続報が出るたびに初報と同じ説明を
 * 読み直すことになる。ここでは事案（incident キー）を単位にして、
 *
 * - 同じ日の同じ事案は、スコアの一番高い 1 件だけを残す
 * - 前の日に出した事案の続報には、前回の要約を渡して差分だけを書かせる
 *
 * の 2 つを行う。キーは要約段の LLM が書き、既知のキーを一覧で渡して同じ文字列を
 * 選ばせる（表記ゆれは normalizeIncidentKey で吸収する）。LLM は通さないので費用はゼロ。
 */

/** 台帳に残す日数。続報はたいてい 2 週間以内に出揃う */
export const INCIDENT_RETENTION_DAYS = 30;

/** LLM に渡す既知の事案キーの上限。多すぎると関係の無いキーに寄せられる */
const KNOWN_KEYS_LIMIT = 40;

export interface IncidentEntry {
  /** 表示用のキー（LLM が最初に書いた形） */
  label: string;
  firstSeen: string;
  lastSeen: string;
  /** 前回までに分かっていたこと。続報の深掘りに渡す */
  summary: string;
}

export type IncidentLedger = Record<string, IncidentEntry>;

/** 空白・記号・大文字小文字の違いを落とした比較用のキー */
export function normalizeIncidentKey(label: string): string {
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・,，、.。:：\-‐–—_/／()（）「」『』]+/g, '');
}

/**
 * 同じ事案を 1 件にまとめる。items はスコアの高い順に並んでいること。
 * incident を持たない記事（特定の事案ではないもの）はまとめずに残す。
 */
export function dedupeByIncident<T extends { incident?: string | null }>(
  items: readonly T[],
  exclude: ReadonlySet<string> = new Set(),
): T[] {
  const seen = new Set(exclude);
  const out: T[] = [];
  for (const item of items) {
    const key = item.incident ? normalizeIncidentKey(item.incident) : '';
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}

/** 要約段に渡す既知のキー。新しく見たものから */
export function knownIncidentLabels(ledger: IncidentLedger): string[] {
  return Object.values(ledger)
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
    .slice(0, KNOWN_KEYS_LIMIT)
    .map((e) => e.label);
}

/**
 * 続報なら前回の要約を返す。今日はじめて見た事案、または今日すでに
 * 書き込まれた事案（同じ日の再実行）なら null。
 */
export function previousSummary(
  ledger: IncidentLedger,
  incident: string | null | undefined,
  date: string,
): string | null {
  if (!incident) return null;
  const entry = ledger[normalizeIncidentKey(incident)];
  if (!entry || entry.firstSeen >= date) return null;
  return entry.summary || null;
}

/**
 * 今日の掲載ぶんを台帳に足し、保持期間の外に出たものを落とす。
 * summary は深掘りしたものだけ書き換える（一覧の 1 行要約で上書きしない）。
 */
export function updateIncidentLedger(
  ledger: IncidentLedger,
  date: string,
  items: readonly { incident?: string | null; summary: string; deep: boolean }[],
): IncidentLedger {
  const next: IncidentLedger = { ...ledger };
  for (const item of items) {
    if (!item.incident) continue;
    const key = normalizeIncidentKey(item.incident);
    if (!key) continue;
    const prev = next[key];
    next[key] = prev
      ? {
          ...prev,
          lastSeen: date > prev.lastSeen ? date : prev.lastSeen,
          summary: item.deep || !prev.summary ? item.summary : prev.summary,
        }
      : { label: item.incident.trim(), firstSeen: date, lastSeen: date, summary: item.summary };
  }

  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - INCIDENT_RETENTION_DAYS);
  const min = cutoff.toISOString().slice(0, 10);
  for (const [key, entry] of Object.entries(next)) {
    if (entry.lastSeen < min) delete next[key];
  }
  return next;
}
