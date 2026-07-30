import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { loadIndex } from '../api';
import { Chip, Empty, Highlight, LoadingCards } from '../components';
import { SOURCE_LABELS, formatDateShort } from '../format';
import type { IndexEntry, Manifest } from '../types';

interface Props {
  manifest: Manifest | null;
  initialQuery: string;
}

/** クエリを空白区切りの語に分解する（日本語は分かち書きしないので部分一致で扱う） */
function tokenize(q: string): string[] {
  return q
    .trim()
    .split(/[\s　]+/)
    .filter(Boolean);
}

function haystack(e: IndexEntry): string {
  return [e.title, e.summary, e.keywords.join(' '), e.topics.join(' '), e.sourceLabel, e.category]
    .join(' ')
    .toLowerCase();
}

/** マッチした語数とヒット位置で並べるための簡易スコア */
function relevance(e: IndexEntry, terms: string[]): number {
  if (terms.length === 0) return e.score;
  const title = e.title.toLowerCase();
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

export function SearchView({ manifest, initialQuery }: Props) {
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [period, setPeriod] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!manifest) return;
    loadIndex(manifest.months).then(setEntries, () => setEntries([]));
  }, [manifest]);

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const terms = useMemo(() => tokenize(query), [query]);

  const { sources, categories } = useMemo(() => {
    const s = new Set<string>();
    const c = new Set<string>();
    for (const e of entries ?? []) {
      s.add(e.source);
      c.add(e.category);
    }
    return { sources: [...s].sort(), categories: [...c].sort() };
  }, [entries]);

  const results = useMemo(() => {
    if (!entries) return [];
    const cutoff =
      period === ''
        ? null
        : new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    return entries
      .filter((e) => !source || e.source === source)
      .filter((e) => !category || e.category === category)
      .filter((e) => !cutoff || e.date >= cutoff)
      .map((e) => ({ entry: e, rel: relevance(e, terms) }))
      .filter((r) => r.rel >= 0)
      .sort((a, b) => (b.rel === a.rel ? b.entry.date.localeCompare(a.entry.date) : b.rel - a.rel))
      .slice(0, 300);
  }, [entries, terms, source, category, period]);

  if (!manifest || !entries) return <LoadingCards count={2} />;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">検索</h1>
        <div className="datebar__meta">
          <span>保存済み {entries.length.toLocaleString()} 件が対象</span>
        </div>
      </div>

      <div className="searchbar">
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="キーワード（例: Next.js キャッシュ / Claude Code hooks）"
          onChange={(e) => {
            setQuery(e.target.value);
            const next = e.target.value
              ? `/search?q=${encodeURIComponent(e.target.value)}`
              : '/search';
            history.replaceState(null, '', `#${next}`);
          }}
        />
        {query && (
          <button type="button" className="btn" onClick={() => setQuery('')}>
            クリア
          </button>
        )}
      </div>

      <div className="filters">
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="ソース">
          <option value="">すべてのソース</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="カテゴリ">
          <option value="">すべてのカテゴリ</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="期間">
          <option value="">全期間</option>
          <option value="7">直近 7 日</option>
          <option value="30">直近 30 日</option>
          <option value="90">直近 90 日</option>
        </select>
      </div>

      <p className="result-count">
        {results.length.toLocaleString()} 件
        {terms.length > 0 && <> ／ 検索語: {terms.join(' + ')}</>}
      </p>

      {results.length === 0 ? (
        <Empty title="該当する記事がありません">
          <p>検索語を減らすか、フィルタを外してみてください。</p>
        </Empty>
      ) : (
        <div className="list">
          {results.map(({ entry }) => (
            <div key={`${entry.date}-${entry.id}`} className="row">
              <div className="row__score">{entry.score}</div>
              <div className="row__main">
                <p className="row__title">
                  <a href={entry.url} target="_blank" rel="noreferrer noopener">
                    <Highlight text={entry.title} terms={terms} />
                  </a>
                </p>
                <p className="row__summary">
                  <Highlight text={entry.summary} terms={terms} />
                </p>
                <div className="row__meta">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => navigate(`/today/${entry.date}`)}
                    title="この日のダイジェストを開く"
                  >
                    {formatDateShort(entry.date)}
                  </button>
                  {entry.rank !== null && <Chip accent>ベスト{entry.rank}</Chip>}
                  <Chip>{entry.category}</Chip>
                  <span>{entry.sourceLabel}</span>
                  {entry.keywords.slice(0, 5).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="chip"
                      onClick={() => setQuery(k)}
                    >
                      #{k}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
