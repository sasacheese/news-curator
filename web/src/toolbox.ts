import { getFeedbackDb } from './firebase';
import type { PassReason, ToolKind, ToolState } from './types';

/**
 * 道具箱の操作（気になる・見送り・触った・URL を貼って追加）。
 *
 * 書き込み先は Firestore で、読むのは翌朝の collector だけ。盤面に反映されるのは
 * 翌朝なので、押した結果はこの端末の localStorage にも持って、すぐ画面に出す
 * （端末ごとの覚え書きで、正は Firestore 側）。
 */

export const KIND_LABELS: Record<ToolKind, string> = {
  cli: 'CLI',
  library: 'ライブラリ',
  skill: 'Skill',
  plugin: 'Plugin',
  mcp: 'MCP',
  saas: 'SaaS',
  cloud: 'クラウド',
  other: 'その他',
};

/** 棚の並び。手元で動かすもの → 繋ぐもの → 外のサービス の順 */
export const KIND_ORDER: ToolKind[] = ['cli', 'library', 'skill', 'plugin', 'mcp', 'saas', 'cloud', 'other'];

export const PASS_REASON_LABELS: Record<PassReason, string> = {
  'have-equivalent': '同等のものを使っている',
  'out-of-scope': '関心の外',
  'too-costly': '試すのが重い（有料・準備が多い）',
  'not-mature': 'まだ早い',
  other: 'その他',
};

export const SOURCE_LABELS: [RegExp, string][] = [
  [/^digest:top/, '今日のベスト'],
  [/^digest:other/, '今日の注目記事'],
  [/^release$/, 'リリース情報'],
  [/^gh-trending$/, 'GitHub 急上昇'],
  [/^show-hn$/, 'Show HN'],
  [/^radar$/, '発掘'],
  [/^mcp-registry$/, 'MCP Registry'],
  [/^claude-marketplace$/, 'Claude Code マーケットプレイス'],
  [/^anthropic-skills$/, 'anthropics/skills'],
  [/^gh-topic:/, 'GitHub topic'],
  [/^cloud:/, 'クラウド'],
  [/^product-hunt$/, 'Product Hunt'],
  [/^manual$/, '自分で追加'],
];

export function sourceLabel(source: string): string {
  const hit = SOURCE_LABELS.find(([re]) => re.test(source));
  if (!hit) return source;
  const suffix = source.includes(':') && /^(gh-topic|cloud):/.test(source) ? ` ${source.split(':')[1]}` : '';
  return `${hit[1]}${suffix}`;
}

/* ---------- 端末側の覚え書き ---------- */

const LOCAL_KEY = 'news-curator:tool-states';

export interface LocalToolState {
  state: ToolState;
  reason?: PassReason | null;
  at: string;
}

export function readLocalStates(): Record<string, LocalToolState> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LocalToolState>) : {};
  } catch {
    return {};
  }
}

function writeLocalState(id: string, value: LocalToolState): void {
  try {
    const map = readLocalStates();
    map[id] = value;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
  } catch {
    // localStorage が使えない環境では、その場の表示だけ変わる
  }
}

/**
 * 盤面の状態と端末の覚え書きを合わせる。盤面のほうが新しければ盤面を採る
 * （別の端末で付けた状態が翌朝の盤面に乗ってきたとき、古い覚え書きで上書きしない）。
 */
export function effectiveState(id: string, boardState: ToolState, boardDate: string): ToolState {
  const local = readLocalStates()[id];
  if (!local) return boardState;
  return local.at.slice(0, 10) >= boardDate ? local.state : boardState;
}

/* ---------- Firestore ---------- */

/** Firestore のドキュメント ID に「/」は使えないので「|」に置き換える（collector 側と対） */
function docIdOf(toolId: string): string {
  return toolId.replace(/\//g, '|');
}

export async function isToolboxWritable(): Promise<boolean> {
  return (await getFeedbackDb()) != null;
}

/** 状態を付ける。成功したら true。失敗しても端末の覚え書きは残す */
export async function setToolState(id: string, state: ToolState, reason?: PassReason | null): Promise<boolean> {
  const at = new Date().toISOString();
  writeLocalState(id, { state, reason: reason ?? null, at });
  const db = await getFeedbackDb();
  if (!db) return false;
  try {
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore/lite');
    await setDoc(doc(db, 'toolState', docIdOf(id)), {
      state,
      reason: reason ?? null,
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (err) {
    console.warn('道具の状態の送信に失敗しました', err);
    return false;
  }
}

/** URL として受け付けるか。https だけ（collector 側でも同じ検査をする） */
export function normalizeSubmittedUrl(raw: string): string | null {
  const text = raw.trim();
  // 共有シートから「本文 + URL」で貼られることがあるので、最初の URL だけ拾う
  const found = /https:\/\/[^\s<>"']+/.exec(text)?.[0];
  if (!found) return null;
  try {
    const u = new URL(found);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function submitToolUrl(url: string): Promise<boolean> {
  const db = await getFeedbackDb();
  if (!db) return false;
  try {
    const { addDoc, collection, serverTimestamp } = await import('firebase/firestore/lite');
    await addDoc(collection(db, 'toolInbox'), { url, createdAt: serverTimestamp() });
    return true;
  } catch (err) {
    console.warn('URL の送信に失敗しました', err);
    return false;
  }
}
