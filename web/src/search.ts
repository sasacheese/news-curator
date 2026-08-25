import type { IndexEntry } from './types';

/**
 * 索引を引く処理。検索画面とクイック検索の両方が使う。
 *
 * 画面ごとに書くと、同じ語で引いたのに順番が違う、という状態になる。
 * 「読みながら引く」ほうは結果を数件しか出さないので、順番のずれが
 * そのまま「出ない」に化ける。並べ方は 1 か所に置く。
 */

/** クエリを空白区切りの語に分解する（日本語は分かち書きしないので部分一致で扱う） */
export function tokenize(q: string): string[] {
  return q
    .trim()
    .split(/[\s　]+/)
    .filter(Boolean);
}

function haystack(e: IndexEntry): string {
  // 日本語の見出しと原題の両方を入れる。英語の記事は原題の語でしか引けないことがある
  return [
    e.title,
    e.titleJa ?? '',
    e.summary,
    e.keywords.join(' '),
    e.topics.join(' '),
    e.sourceLabel,
    e.category,
  ]
    .join(' ')
    .toLowerCase();
}

/** マッチした語数とヒット位置で並べるための簡易スコア */
export function relevance(e: IndexEntry, terms: string[]): number {
  if (terms.length === 0) return e.score;
  const title = `${e.title} ${e.titleJa ?? ''}`.toLowerCase();
  const keywords = e.keywords.join(' ').toLowerCase();
  const hay = haystack(e);

  let score = 0;
  for (const t of terms) {
    const term = t.toLowerCase();
    if (!hay.includes(term)) return -1; // AND 検索
    if (title.includes(term)) score += 12;
    if (keywords.includes(term)) score += 8;
    score += 3;
  }
  if (e.rank !== null) score += 6;
  return score + e.score / 20;
}

export interface SearchOptions {
  source?: string;
  category?: string;
  limit?: number;
}

/** 関連度の高い順に並べて返す。同点なら新しい日から */
export function searchEntries(
  entries: readonly IndexEntry[],
  terms: string[],
  { source = '', category = '', limit = 300 }: SearchOptions = {},
): IndexEntry[] {
  return entries
    .filter((e) => !source || e.source === source)
    .filter((e) => !category || e.category === category)
    .map((e) => ({ entry: e, rel: relevance(e, terms) }))
    .filter((r) => r.rel >= 0)
    .sort((a, b) => (b.rel === a.rel ? b.entry.date.localeCompare(a.entry.date) : b.rel - a.rel))
    .slice(0, limit)
    .map((r) => r.entry);
}
