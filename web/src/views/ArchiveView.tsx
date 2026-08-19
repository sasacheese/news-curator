import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { loadIndexShard } from '../api';
import { Chip, Empty, LoadingCards, MonthPicker } from '../components';
import { daysPerMonth, displayTitle, formatDateLabel } from '../format';
import type { IndexEntry, Manifest } from '../types';

/**
 * 日ごとの一覧を月単位で見る。
 *
 * 以前は全月のインデックスをまとめて読んでいたが、それだと表示量が一定なのに
 * 転送量だけがアーカイブの長さに比例して増えていく。読み込みの単位を表示の
 * 単位（1 ヶ月）と一致させて、何年ぶん貯まっても一定になるようにした。
 */
export function ArchiveView({ manifest }: { manifest: Manifest | null }) {
  const months = manifest?.months ?? [];
  const latestMonth = months[0] ?? null;
  const [month, setMonth] = useState<string | null>(null);
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);

  // 既定は最新の月
  useEffect(() => {
    if (latestMonth) setMonth((m) => m ?? latestMonth);
  }, [latestMonth]);

  useEffect(() => {
    if (!month) return;
    let cancelled = false;
    setEntries(null);
    loadIndexShard(month, latestMonth).then(
      (e) => !cancelled && setEntries(e),
      () => !cancelled && setEntries([]),
    );
    return () => {
      cancelled = true;
    };
  }, [month, latestMonth]);

  const dayCounts = useMemo(() => daysPerMonth(manifest?.dates ?? []), [manifest?.dates]);

  // その月に属する日付だけを新しい順に
  const datesInMonth = useMemo(
    () => (manifest?.dates ?? []).filter((d) => month && d.startsWith(month)),
    [manifest?.dates, month],
  );

  const byDate = useMemo(() => {
    const map = new Map<string, IndexEntry[]>();
    for (const e of entries ?? []) {
      const list = map.get(e.date);
      if (list) list.push(e);
      else map.set(e.date, [e]);
    }
    return map;
  }, [entries]);

  if (!manifest) return <LoadingCards count={4} />;
  if (manifest.dates.length === 0) return <Empty title="まだアーカイブがありません" />;

  return (
    <>
      <div className="datebar">
        <h1 className="datebar__date">アーカイブ</h1>
        <div className="datebar__meta">
          <span>
            全 {manifest.dates.length} 日分 / {months.length} ヶ月
          </span>
        </div>
      </div>

      <div className="filters">
        {month && (
          <MonthPicker months={months} value={month} onChange={setMonth} dayCounts={dayCounts} />
        )}
      </div>

      {!entries ? (
        <LoadingCards count={3} />
      ) : (
        datesInMonth.map((date) => {
          const all = byDate.get(date) ?? [];
          const items = all
            .filter((e) => e.rank !== null)
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
          return (
            <button
              key={date}
              type="button"
              className="archive-day"
              onClick={() => navigate(`/today/${date}`)}
            >
              <div className="archive-day__date">
                {formatDateLabel(date)}
                <Chip>{all.length} 件</Chip>
              </div>
              {items.length > 0 ? (
                <ol className="archive-day__list">
                  {items.map((e) => (
                    <li key={e.id}>{e.summary || displayTitle(e)}</li>
                  ))}
                </ol>
              ) : (
                <p className="faint" style={{ margin: 0, fontSize: 13 }}>
                  この日の詳細を開く
                </p>
              )}
            </button>
          );
        })
      )}
    </>
  );
}
