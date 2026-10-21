import type {
  PassReason,
  ToolBoard,
  ToolBoardItem,
  ToolEntry,
  ToolIdentity,
  ToolKind,
  ToolLedger,
  ToolSignal,
  ToolState,
} from './types.js';
import { PASS_REASONS, TOOL_KINDS, TOOL_STATES } from './types.js';
import { normalizeUrl } from './util.js';

/* ------------------------------------------------------------------ *
 * 道具箱の台帳と盤面（ここは全部ルールベース。外部 API も LLM も呼ばない）
 *
 * 一覧を抑える仕組みは 4 つで、どれも「消す」ではなく「見える場所から退かせる」。
 * 1. 新着のまま ARCHIVE_DAYS 日放置したら退避（state: archived）
 * 2. 退避したものに新しい信号が来たら再浮上（state: new に戻す）
 * 3. 見送りの理由を集計して、同じ種類・同じ置き換え先の道具の点数を下げる
 * 4. 盤面に出す件数の上限（BOARD_LIMIT）
 * ------------------------------------------------------------------ */

/** 新着のまま放置したら退避するまでの日数 */
export const ARCHIVE_DAYS = 7;

/** 盤面の「新着」に並べる上限。網羅が目的なので多めに取る */
export const BOARD_LIMIT = 300;

/** 1 道具が持つ信号の上限。古いものから捨てる */
const SIGNAL_LIMIT = 12;

/** 信号の強さの半減期（日）。1 週間前に見かけたものは今日見かけたものの半分 */
const HALF_LIFE_DAYS = 7;

/** 入口が渡してくる 1 件。台帳に無ければ新しい道具になる */
export interface ToolCandidate {
  identity: ToolIdentity;
  name: string;
  homepage: string;
  signal: ToolSignal;
  /** 入口で種類が確定しているとき（MCP Registry 由来なら mcp など） */
  kindHint?: ToolKind;
  description?: string | null;
  requires?: string[];
  trust?: Partial<ToolEntry['trust']>;
}

/** 読者が付けた状態（Firestore の toolState から読む） */
export interface ToolStateUpdate {
  id: string;
  state: ToolState;
  reason?: PassReason | null;
  at: string;
}

export function emptyLedger(): ToolLedger {
  return { updatedAt: new Date(0).toISOString(), tools: {} };
}

/**
 * 道具の ID。GitHub を優先する（npm パッケージの大半は GitHub に置かれていて、
 * リポジトリのほうが道具の単位として安定している——モノレポの複数パッケージは同じ道具）。
 */
export function toolIdOf(identity: ToolIdentity): string | null {
  if (identity.github) return `gh:${identity.github.toLowerCase()}`;
  if (identity.npm) return `npm:${identity.npm.toLowerCase()}`;
  if (identity.url) return `url:${normalizeUrl(identity.url)}`;
  return null;
}

/** 身元のどれか 1 つでも一致すれば同じ道具とみなすための索引 */
function identityKeys(identity: ToolIdentity): string[] {
  const keys: string[] = [];
  if (identity.github) keys.push(`gh:${identity.github.toLowerCase()}`);
  if (identity.npm) keys.push(`npm:${identity.npm.toLowerCase()}`);
  if (identity.url) keys.push(`url:${normalizeUrl(identity.url)}`);
  return keys;
}

function buildIndex(ledger: ToolLedger): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of Object.values(ledger.tools)) {
    for (const key of identityKeys(entry.identity)) index.set(key, entry.id);
    index.set(entry.id, entry.id);
  }
  return index;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface MergeResult {
  ledger: ToolLedger;
  added: string[];
  resurfaced: string[];
  /** candidates と同じ並びで、それぞれがどの道具になったか（登録できなければ null） */
  ids: (string | null)[];
}

/**
 * 入口の候補を台帳に足す。
 *
 * 既知の道具には信号を足すだけ。退避済みの道具に**今日の**信号が来たら再浮上させる。
 * 見送った道具は再浮上させない——読者が一度判断したものを毎週出し直すと、
 * 判断した意味がなくなる。
 */
export function mergeCandidates(
  ledger: ToolLedger,
  candidates: readonly ToolCandidate[],
  date: string,
): MergeResult {
  const tools: Record<string, ToolEntry> = { ...ledger.tools };
  const index = buildIndex(ledger);
  const added: string[] = [];
  const resurfaced: string[] = [];
  const ids: (string | null)[] = [];

  for (const c of candidates) {
    const id = identityKeys(c.identity)
      .map((k) => index.get(k))
      .find(Boolean);

    if (!id) {
      const newId = toolIdOf(c.identity);
      if (!newId || tools[newId]) {
        ids.push(newId && tools[newId] ? newId : null);
        continue;
      }
      tools[newId] = {
        id: newId,
        name: c.name.trim(),
        kind: c.kindHint ?? 'other',
        identity: { ...c.identity },
        homepage: c.homepage,
        summary: null,
        replaces: null,
        requires: c.requires ?? [],
        trust: {
          official: c.trust?.official ?? false,
          author: c.trust?.author ?? null,
          stars: c.trust?.stars ?? null,
          archived: c.trust?.archived ?? null,
          license: c.trust?.license ?? null,
        },
        description: c.description?.trim() || null,
        signals: [c.signal],
        firstSeen: date,
        lastSignal: date,
        state: 'new',
        stateAt: date,
        inspected: false,
        described: false,
      };
      for (const key of identityKeys(c.identity)) index.set(key, newId);
      index.set(newId, newId);
      added.push(newId);
      ids.push(newId);
      continue;
    }
    ids.push(id);

    const prev = tools[id]!;
    const duplicate = prev.signals.some(
      (s) => s.source === c.signal.source && s.date === c.signal.date,
    );
    const signals = duplicate ? prev.signals : [...prev.signals, c.signal].slice(-SIGNAL_LIMIT);
    const next: ToolEntry = {
      ...prev,
      identity: { ...c.identity, ...prev.identity },
      signals,
      lastSignal: c.signal.date > prev.lastSignal ? c.signal.date : prev.lastSignal,
      description: prev.description ?? (c.description?.trim() || null),
      requires: prev.requires.length ? prev.requires : (c.requires ?? []),
    };
    if (prev.state === 'archived' && c.signal.date === date && !duplicate) {
      next.state = 'new';
      next.stateAt = date;
      next.resurfacedAt = date;
      resurfaced.push(id);
    }
    tools[id] = next;
  }

  return { ledger: { ...ledger, tools }, added, resurfaced, ids };
}

/**
 * 読者の操作を反映する。台帳の状態より新しい操作だけを採る
 * （同じ日に collector が退避させた道具を、前日の操作で戻さないため）。
 */
export function applyStateUpdates(
  ledger: ToolLedger,
  updates: readonly ToolStateUpdate[],
): ToolLedger {
  const tools = { ...ledger.tools };
  for (const u of updates) {
    const prev = tools[u.id];
    if (!prev || !TOOL_STATES.includes(u.state) || u.state === 'archived') continue;
    const at = u.at.slice(0, 10);
    if (at < prev.stateAt && prev.state !== 'new') continue;
    tools[u.id] = {
      ...prev,
      state: u.state,
      stateAt: at,
      passReason:
        u.state === 'passed' ? (u.reason && PASS_REASONS.includes(u.reason) ? u.reason : 'other') : null,
    };
  }
  return { ...ledger, tools };
}

/** 新着のまま ARCHIVE_DAYS 日放置したものを退避させる。退避させた ID を返す */
export function archiveStale(ledger: ToolLedger, date: string): { ledger: ToolLedger; archived: string[] } {
  const tools = { ...ledger.tools };
  const archived: string[] = [];
  for (const [id, entry] of Object.entries(tools)) {
    if (entry.state !== 'new') continue;
    if (daysBetween(entry.stateAt, date) < ARCHIVE_DAYS) continue;
    tools[id] = { ...entry, state: 'archived', stateAt: date };
    archived.push(id);
  }
  return { ledger: { ...ledger, tools }, archived };
}

/**
 * 見送りの学習。直近 60 日の見送りを集計して、種類ごと・置き換え先ごとの係数を返す。
 *
 * - 種類: その種類で読者が操作したもののうち、見送った割合が高いほど下げる（最大 4 割）
 * - 置き換え先:「同等品を使っている」で見送った道具と同じものを置き換える道具は半分にする
 *   （「Jest の代わり」を見送ったなら、別の「Jest の代わり」も同じ理由で要らない可能性が高い）
 */
export function passPenalties(
  ledger: ToolLedger,
  date: string,
): { byKind: Map<ToolKind, number>; byReplaces: Set<string> } {
  const acted = new Map<ToolKind, { passed: number; total: number }>();
  const byReplaces = new Set<string>();
  for (const e of Object.values(ledger.tools)) {
    if (e.state === 'new' || e.state === 'archived') continue;
    if (daysBetween(e.stateAt, date) > 60) continue;
    const a = acted.get(e.kind) ?? { passed: 0, total: 0 };
    a.total++;
    if (e.state === 'passed') {
      a.passed++;
      if (e.passReason === 'have-equivalent' && e.replaces) byReplaces.add(e.replaces.trim().toLowerCase());
    }
    acted.set(e.kind, a);
  }
  const byKind = new Map<ToolKind, number>();
  for (const [kind, a] of acted) {
    // 1 件や 2 件の操作で棚ごと沈めない
    if (a.total < 3) continue;
    byKind.set(kind, 1 - 0.4 * (a.passed / a.total));
  }
  return { byKind, byReplaces };
}

/**
 * 盤面に並べる順の点数。信号の強さ × 新しさの減衰の和に、信頼の目印を少し足す。
 * 「何度も・最近・強い入口で見かけたもの」が上に来る。
 */
export function scoreTool(
  entry: ToolEntry,
  date: string,
  penalties: ReturnType<typeof passPenalties>,
): number {
  let s = 0;
  for (const sig of entry.signals) {
    const age = Math.max(0, daysBetween(sig.date, date));
    s += sig.strength * 0.5 ** (age / HALF_LIFE_DAYS);
  }
  if (entry.trust.official) s += 0.3;
  if (entry.trust.stars) s += Math.min(0.5, Math.log10(entry.trust.stars + 1) / 8);
  if (entry.trust.archived) s *= 0.3;
  s *= penalties.byKind.get(entry.kind) ?? 1;
  if (entry.replaces && penalties.byReplaces.has(entry.replaces.trim().toLowerCase())) s *= 0.5;
  return Math.round(s * 1000) / 1000;
}

export function toBoardItem(
  entry: ToolEntry,
  date: string,
  score: number,
  tryPrompt: string | null,
): ToolBoardItem {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    homepage: entry.homepage,
    summary: entry.summary ?? entry.description,
    replaces: entry.replaces,
    requires: entry.requires,
    trust: entry.trust,
    state: entry.state,
    seenIn: entry.signals
      .slice()
      .reverse()
      .slice(0, 4)
      .map((s) => ({ source: s.source, date: s.date, title: s.title, url: s.url })),
    firstSeen: entry.firstSeen,
    lastSignal: entry.lastSignal,
    isNew: entry.firstSeen === date,
    resurfaced: entry.resurfacedAt === date,
    score,
    tryPrompt,
  };
}

export function buildToolBoard(
  ledger: ToolLedger,
  date: string,
  opts: {
    addedToday: number;
    resurfacedToday: number;
    notes: string[];
    tryPromptOf: (entry: ToolEntry) => string | null;
  },
): ToolBoard {
  const penalties = passPenalties(ledger, date);
  const entries = Object.values(ledger.tools);
  const item = (e: ToolEntry) => toBoardItem(e, date, scoreTool(e, date, penalties), opts.tryPromptOf(e));
  const byScore = (a: ToolBoardItem, b: ToolBoardItem) =>
    b.score - a.score || (a.lastSignal < b.lastSignal ? 1 : -1);

  const queue = entries
    .filter((e) => e.state === 'interested' || e.state === 'prepared')
    .map(item)
    // 準備済みを先に。どちらも新しく押したものから
    .sort((a, b) =>
      a.state !== b.state ? (a.state === 'prepared' ? -1 : 1) : a.lastSignal < b.lastSignal ? 1 : -1,
    );
  const items = entries
    .filter((e) => e.state === 'new')
    .map(item)
    .sort(byScore)
    .slice(0, BOARD_LIMIT);
  const tried = entries
    .filter((e) => e.state === 'tried')
    .sort((a, b) => (a.stateAt < b.stateAt ? 1 : -1))
    .slice(0, 30)
    .map(item);

  const byKind: Record<string, number> = Object.fromEntries(TOOL_KINDS.map((k) => [k, 0]));
  for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;

  return {
    updatedAt: new Date().toISOString(),
    date,
    queue,
    items,
    tried,
    byKind,
    stats: {
      ledger: entries.length,
      archived: entries.filter((e) => e.state === 'archived').length,
      passed: entries.filter((e) => e.state === 'passed').length,
      addedToday: opts.addedToday,
      resurfacedToday: opts.resurfacedToday,
    },
    notes: opts.notes,
  };
}
