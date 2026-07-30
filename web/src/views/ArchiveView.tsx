import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { loadIndex } from '../api';
import { Chip, Empty, LoadingCards } from '../components';
import { formatDateLabel } from '../format';
import type { IndexEntry, Manifest } from '../types';

export function ArchiveView({ manifest }: { manifest: Manifest | null }) {
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);

  useEffect(() => {
    if (!manifest) return;
    loadIndex(manifest.months).then(setEntries, () => setEntries([]));
  }, [manifest]);

  if (!manifest || !entries) return <LoadingCards count={4} />;

  if (manifest.dates.length === 0) {
    return <Empty title="まだアーカイブがありません" />;
  }

  const byDate = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">アーカイブ</h1>
        <div className="datebar__meta">
          <span>{manifest.dates.length} 日分 / 全 {entries.length} 件</span>
        </div>
      </div>

      {manifest.dates.map((date) => {
        const items = (byDate.get(date) ?? []).filter((e) => e.rank !== null).sort(
          (a, b) => (a.rank ?? 99) - (b.rank ?? 99),
        );
        const total = byDate.get(date)?.length ?? 0;
        return (
          <button
            key={date}
            type="button"
            className="archive-day"
            onClick={() => navigate(`/today/${date}`)}
          >
            <div className="archive-day__date">
              {formatDateLabel(date)}
              <Chip>{total} 件</Chip>
            </div>
            {items.length > 0 ? (
              <ol className="archive-day__list">
                {items.map((e) => (
                  <li key={e.id}>{e.summary || e.title}</li>
                ))}
              </ol>
            ) : (
              <p className="faint" style={{ margin: 0, fontSize: 13 }}>
                この日の詳細を開く
              </p>
            )}
          </button>
        );
      })}
    </>
  );
}
