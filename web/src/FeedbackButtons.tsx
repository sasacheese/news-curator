import { useState } from 'react';
import { getFeedbackDb } from './firebase';
import { isFeedbackUnlocked } from './settings';
import type { Lane } from './types';

export type FeedbackVote = 'good' | 'bad';

export interface FeedbackTarget {
  id: string;
  tier: 'top' | 'other' | 'release';
  digestDate: string;
  source: string;
  sourceLabel: string;
  title: string;
  url: string;
  category?: string;
  lane?: Lane;
  matchedTopics?: string[];
  score?: number;
}

const VOTES_KEY = 'news-curator:feedback-votes';

function readLocalVote(id: string): FeedbackVote | null {
  try {
    const map = JSON.parse(localStorage.getItem(VOTES_KEY) ?? '{}') as Record<string, FeedbackVote>;
    return map[id] ?? null;
  } catch {
    return null;
  }
}

function writeLocalVote(id: string, vote: FeedbackVote): void {
  try {
    const map = JSON.parse(localStorage.getItem(VOTES_KEY) ?? '{}') as Record<string, FeedbackVote>;
    map[id] = vote;
    localStorage.setItem(VOTES_KEY, JSON.stringify(map));
  } catch {
    // localStorage が使えない環境では黙って諦める（投票の記憶が残らないだけ）
  }
}

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 14;

/** Firestore への書き込み。失敗しても画面には出さず console にだけ残す */
async function submitFeedback(target: FeedbackTarget, vote: FeedbackVote): Promise<void> {
  const db = await getFeedbackDb();
  if (!db) return;
  try {
    const { doc, setDoc, serverTimestamp, Timestamp } = await import('firebase/firestore/lite');
    await setDoc(doc(db, 'feedback', target.id), {
      articleId: target.id,
      vote,
      votedAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RETENTION_DAYS * DAY_MS),
      digestDate: target.digestDate,
      tier: target.tier,
      source: target.source,
      sourceLabel: target.sourceLabel,
      category: target.category ?? '',
      lane: target.lane ?? null,
      matchedTopics: target.matchedTopics ?? [],
      score: target.score ?? null,
      title: target.title,
      url: target.url,
    });
  } catch (err) {
    console.warn('フィードバックの送信に失敗しました', err);
  }
}

export function FeedbackButtons({ target }: { target: FeedbackTarget }) {
  const [vote, setVote] = useState<FeedbackVote | null>(() => readLocalVote(target.id));

  if (!isFeedbackUnlocked()) return null;

  const cast = (next: FeedbackVote) => {
    setVote(next);
    writeLocalVote(target.id, next);
    void submitFeedback(target, next);
  };

  return (
    <div className="feedback">
      <button
        type="button"
        className={vote === 'good' ? 'feedback__btn feedback__btn--good' : 'feedback__btn'}
        aria-pressed={vote === 'good'}
        title="この記事はおすすめの基準に合っている"
        onClick={() => cast('good')}
      >
        Good
      </button>
      <button
        type="button"
        className={vote === 'bad' ? 'feedback__btn feedback__btn--bad' : 'feedback__btn'}
        aria-pressed={vote === 'bad'}
        title="この記事はおすすめの基準に合っていない"
        onClick={() => cast('bad')}
      >
        Bad
      </button>
    </div>
  );
}
