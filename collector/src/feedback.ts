import type { TopicsConfig } from './types.js';
import { log } from './util.js';

const LOOKBACK_DAYS = 14;
/** Laplace 平滑化の強さ。1〜2 票の偏りでは重みがほぼ動かないようにする */
const PRIOR = 3;

interface Tally {
  good: number;
  bad: number;
}

export interface FeedbackSignal {
  totalVotes: number;
  byTopic: Map<string, Tally>;
}

/**
 * firebase-admin は FIREBASE_SERVICE_ACCOUNT_JSON が無ければ読み込まない。
 * 未設定の環境（この機能を使わない fork など）でトップレベル import が
 * 失敗しないよう、動的 import にする。
 */
async function getAdminDb() {
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

/** 直近 LOOKBACK_DAYS 分の投票を取得し、トピック名ごとに集計する */
export async function loadFeedbackSignal(): Promise<FeedbackSignal | null> {
  const admin = await getAdminDb();
  if (!admin) return null;

  const since = admin.Timestamp.fromMillis(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const snap = await admin.db.collection('feedback').where('votedAt', '>=', since).get();

  const byTopic = new Map<string, Tally>();
  let totalVotes = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.vote !== 'good' && d.vote !== 'bad') continue;
    totalVotes++;

    const topics = Array.isArray(d.matchedTopics) ? (d.matchedTopics as string[]) : [];
    for (const name of topics) {
      const t = byTopic.get(name) ?? { good: 0, bad: 0 };
      if (d.vote === 'good') t.good++;
      else t.bad++;
      byTopic.set(name, t);
    }
  }

  return { totalVotes, byTopic };
}

/** good の割合を 0.5 中心の平滑化済み比率にし、0.75〜1.25 倍の重み乗数へ写像する */
function multiplier(t: Tally): number {
  const ratio = (t.good + PRIOR) / (t.good + t.bad + PRIOR * 2);
  return 0.75 + ratio * 0.5;
}

/**
 * topics.json のトピック重みに、直近のフィードバックから得た乗数をかけた
 * 複製を返す。prescore.ts の preScore() 自体は一切変更しない。
 */
export function applyFeedbackToTopics(topics: TopicsConfig, signal: FeedbackSignal): TopicsConfig {
  return {
    ...topics,
    topics: topics.topics.map((t) => {
      const tally = signal.byTopic.get(t.name);
      if (!tally || tally.good + tally.bad === 0) return t;
      return { ...t, weight: t.weight * multiplier(tally) };
    }),
  };
}

/** LLM プロンプトに足す短い一文。動きが小さいトピックは出さない */
export function renderFeedbackNote(signal: FeedbackSignal): string | null {
  const notable = [...signal.byTopic.entries()]
    .map(([name, t]) => ({ name, m: multiplier(t), n: t.good + t.bad }))
    .filter((e) => e.n >= PRIOR && Math.abs(e.m - 1) >= 0.08)
    .sort((a, b) => Math.abs(b.m - 1) - Math.abs(a.m - 1))
    .slice(0, 3);

  if (notable.length === 0) return null;

  const parts = notable.map((e) => `${e.name}${e.m > 1 ? 'への評価が高め' : 'への評価が低め'}`);
  return `直近${LOOKBACK_DAYS}日の読者フィードバックでは、${parts.join('、')}です。`;
}
