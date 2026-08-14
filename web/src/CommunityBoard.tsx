import { FeedbackButtons } from './FeedbackButtons';
import { safeUrl } from './format';
import type { CommunityAction, CommunityItem } from './types';

/**
 * コミュニティの盤面（イベント・登壇募集・もくもく会）。
 *
 * 記事ともリリースとも軸が違う。**読者が最初に知りたいのは「いつか」**なので、
 * 日付を主役にする。リリース情報のような一列のリストではなく、
 * 日付ストリップ + 日付ごとのアジェンダで、カレンダーに近い読み方ができるようにする。
 *
 * ただし登壇募集だけは日付の軸が違う。開催日ではなく**応募締切**で動くもので、
 * 「開催は 3 か月後だが締切は明日」が普通にある。開催日の列に混ぜると
 * 3 か月先に沈むので、締切を持つものは先頭の別セクションに出す。
 */

const ACTION_LABELS: Record<CommunityAction, string> = {
  speak: '登壇',
  attend: '参加',
  work: 'もくもく',
};

const MODE_LABELS = {
  online: 'オンライン',
  onsite: '現地',
  hybrid: '現地+オンライン',
} as const;

/* ------------------------------------------------------------------ *
 * 日付
 *
 * すべて JST の暦日で扱う。閲覧者の時間帯で日付がずれると
 * 「今日」の位置が動いてしまい、盤面としての意味が壊れる。
 * ------------------------------------------------------------------ */

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** ISO 文字列 → JST の YYYY-MM-DD */
function jstDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // sv-SE は YYYY-MM-DD を返す。ロケール依存の並びに引きずられない
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
}

function jstTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** YYYY-MM-DD を日数ぶんずらす */
function shiftDay(key: string, days: number): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

interface DayMeta {
  key: string;
  month: number;
  day: number;
  weekday: string;
  /** 土日。行ける日かどうかが平日と大きく違うので、目で分かるようにする */
  isWeekend: boolean;
  offset: number;
  /** 今日 / 明日 / あさって / N日後 */
  relative: string;
}

function dayMeta(key: string, today: string): DayMeta {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offset = daysBetween(today, key);
  return {
    key,
    month: m,
    day: d,
    weekday: WEEKDAYS[wd] ?? '',
    isWeekend: wd === 0 || wd === 6,
    offset,
    relative:
      offset === 0 ? '今日' : offset === 1 ? '明日' : offset === 2 ? 'あさって' : `${offset}日後`,
  };
}

/* ------------------------------------------------------------------ *
 * 行
 * ------------------------------------------------------------------ */

function capacityLabel(item: CommunityItem): string | null {
  const c = item.capacity;
  if (!c || c.accepted == null) return null;
  if (c.limit == null || c.limit === 0) return `${c.accepted}人が参加予定`;
  if (c.accepted >= c.limit) return c.waiting ? `満席（補欠${c.waiting}）` : '満席';
  return `${c.accepted}/${c.limit}人`;
}

function isFull(item: CommunityItem): boolean {
  const c = item.capacity;
  return c?.limit != null && c.limit > 0 && (c.accepted ?? 0) >= c.limit;
}

/** speak の題材。名詞句だけを並べる。文にすると発表の代筆になる */
function Angles({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="comm__angles">
      <p className="comm__angles-label">あなたが出せる題材</p>
      <ul className="angles">
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Doorkeeper の主催名はサブドメインから取っているので、コミュニティ名ではなく
 * ランダムな識別子のことがある（実測: `c5dc59ed978213830355fc8978`）。
 * 読み手に意味が無いので出さない。畳み込みのキーとしては引き続き有効。
 */
function displayOrganizer(organizer: string | null): string | null {
  if (!organizer) return null;
  return /^[0-9a-f]{16,}$/i.test(organizer) ? null : organizer;
}

function Meta({ item }: { item: CommunityItem }) {
  const capacity = capacityLabel(item);
  const organizer = displayOrganizer(item.organizer);
  return (
    <p className="comm__meta">
      <span className={`comm__mode comm__mode--${item.venue.mode}`}>
        {MODE_LABELS[item.venue.mode]}
      </span>
      {item.venue.prefecture && <span className="comm__place">{item.venue.prefecture}</span>}
      {capacity && <span className="comm__capacity">{capacity}</span>}
      {organizer && <span className="comm__organizer">{organizer}</span>}
      <span className="comm__source">{item.sourceLabel}</span>
    </p>
  );
}

function Feedback({ item, boardDate }: { item: CommunityItem; boardDate: string }) {
  return (
    <FeedbackButtons
      target={{
        id: item.id,
        tier: 'community',
        digestDate: boardDate,
        source: '(community)',
        sourceLabel: item.sourceLabel,
        title: item.title,
        url: item.url,
        category: ACTION_LABELS[item.action],
        matchedTopics: item.matchedTopics,
      }}
    />
  );
}

/** 締切セクションの行。締切までの日数を主役にする */
function DeadlineRow({ item, boardDate }: { item: CommunityItem; boardDate: string }) {
  const left = item.deadline?.daysLeft ?? 0;
  const meta = item.deadline ? dayMeta(jstDayKey(item.deadline.at), boardDate) : null;
  const eventDay = dayMeta(jstDayKey(item.startsAt), boardDate);

  return (
    <li className="cfp">
      <div className={`cfp__count${left <= 3 ? ' cfp__count--urgent' : ''}`}>
        <span className="cfp__count-num">{left}</span>
        <span className="cfp__count-unit">日</span>
      </div>
      <div className="cfp__body">
        <p className="comm__head">
          {item.isNew && <span className="comm__new">NEW</span>}
          <a
            className="comm__title"
            href={safeUrl(item.url)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {item.title}
          </a>
        </p>
        <p className="cfp__dates">
          <span className="cfp__deadline">
            締切 {meta && `${meta.month}/${meta.day}(${meta.weekday})`}
          </span>
          <span className="cfp__sep" aria-hidden="true">
            ·
          </span>
          <span>
            開催 {eventDay.month}/{eventDay.day}
          </span>
        </p>
        {item.callFor && <p className="comm__callfor">{item.callFor}</p>}
        {item.what && <p className="comm__what">{item.what}</p>}
        <Angles items={item.angles} />
        <Meta item={item} />
        <Feedback item={item} boardDate={boardDate} />
      </div>
    </li>
  );
}

/** アジェンダの行。日付は見出しが持っているので、行は時刻から始める */
function AgendaRow({ item, boardDate }: { item: CommunityItem; boardDate: string }) {
  const full = isFull(item);
  const endsDay = item.endsAt ? dayMeta(jstDayKey(item.endsAt), boardDate) : null;

  return (
    /*
     * 時刻は左の固定列に出す。本文と同じ行に流すと、タイトルが長い日に
     * 時刻だけが 1 行目に取り残されて、どの行の時刻なのか分からなくなる。
     */
    <li className={`comm${full ? ' comm--full' : ''}`}>
      <span className="comm__time">{jstTime(item.startsAt)}</span>
      <div className="comm__body">
        <p className="comm__head">
          {item.isNew && <span className="comm__new">NEW</span>}
          <a
            className="comm__title"
            href={safeUrl(item.url)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {item.title}
          </a>
          {item.action !== 'attend' && (
            <span className={`comm__tag comm__tag--${item.action}`}>
              {ACTION_LABELS[item.action]}
            </span>
          )}
          {endsDay && (
            <span className="comm__span">
              〜 {endsDay.month}/{endsDay.day}({endsDay.weekday})
            </span>
          )}
        </p>
        {item.callFor && <p className="comm__callfor">{item.callFor}</p>}
        {item.what && <p className="comm__what">{item.what}</p>}
        <Angles items={item.angles} />
        <Meta item={item} />
        <Feedback item={item} boardDate={boardDate} />
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * 盤面
 * ------------------------------------------------------------------ */

function jumpToDay(key: string): void {
  document.getElementById(`day-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 日付ストリップ。今日から 3 週間ぶんを 1 行に並べる。
 *
 * 一覧を上から読まなくても「いつ何かがあるか」が形で分かるようにするための帯。
 * 件数はドットで出す（数字を並べると密度が上がって、逆に読み取りにくい）。
 */
function DateStrip({
  days,
  countsByDay,
  today,
}: {
  days: string[];
  countsByDay: Map<string, number>;
  today: string;
}) {
  return (
    <div className="daystrip" role="list" aria-label="開催日の一覧">
      {days.map((key) => {
        const meta = dayMeta(key, today);
        const count = countsByDay.get(key) ?? 0;
        const classes = [
          'daystrip__day',
          meta.isWeekend ? 'daystrip__day--weekend' : '',
          meta.offset === 0 ? 'daystrip__day--today' : '',
          count === 0 ? 'daystrip__day--empty' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <button
            key={key}
            type="button"
            role="listitem"
            className={classes}
            disabled={count === 0}
            aria-label={`${meta.month}月${meta.day}日(${meta.weekday}) ${count}件`}
            onClick={() => jumpToDay(key)}
          >
            <span className="daystrip__wd">{meta.weekday}</span>
            <span className="daystrip__num">{meta.day}</span>
            <span className="daystrip__dots" aria-hidden="true">
              {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                <span key={i} className="daystrip__dot" />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DayGroup({
  meta,
  items,
  boardDate,
}: {
  meta: DayMeta;
  items: CommunityItem[];
  boardDate: string;
}) {
  return (
    <section className="dayblock" id={`day-${meta.key}`}>
      <h3 className={`dayblock__head${meta.isWeekend ? ' dayblock__head--weekend' : ''}`}>
        <span className="dayblock__date">
          {meta.month}/{meta.day}
        </span>
        <span className="dayblock__wd">({meta.weekday})</span>
        <span className="dayblock__rel">{meta.relative}</span>
      </h3>
      <ul className="comm-list">
        {items.map((item) => (
          <AgendaRow key={item.id} item={item} boardDate={boardDate} />
        ))}
      </ul>
    </section>
  );
}

export function CommunityBoard({
  items,
  boardDate,
  horizonDays = 21,
}: {
  items: CommunityItem[];
  /** 盤面の生成日（JST）。「今日」の基準 */
  boardDate: string;
  horizonDays?: number;
}) {
  /*
   * 締切を持つ登壇募集だけ日付の軸から外す。開催日で並べると 3 か月先に沈むが、
   * 読者が動くのは締切のほう。締切が読めなかったものは開催日で並べる
   * （どちらか一方にしか出ないので、同じイベントが 2 度並ぶことはない）。
   */
  const withDeadline = items
    .filter((i) => i.deadline)
    .sort((a, b) => (a.deadline?.daysLeft ?? 0) - (b.deadline?.daysLeft ?? 0));
  const dated = items.filter((i) => !i.deadline).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const days = Array.from({ length: horizonDays + 1 }, (_, i) => shiftDay(boardDate, i));
  const lastDay = days[days.length - 1] ?? boardDate;

  const byDay = new Map<string, CommunityItem[]>();
  const later: CommunityItem[] = [];
  for (const item of dated) {
    const key = jstDayKey(item.startsAt);
    // 過去日は出さない（生成から日が経った盤面を開いたとき）
    if (!key || key < boardDate) continue;
    if (key > lastDay) {
      later.push(item);
      continue;
    }
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }

  const countsByDay = new Map([...byDay].map(([k, v]) => [k, v.length]));

  return (
    <div className="community">
      {withDeadline.length > 0 && (
        <section className="cfp-section">
          <h2 className="section-title">応募の締切 ({withDeadline.length})</h2>
          <p className="section-lead">
            開催日ではなく締切の近い順です。開催が先でも、締切が過ぎれば出せません。
          </p>
          <ul className="cfp-list">
            {withDeadline.map((item) => (
              <DeadlineRow key={item.id} item={item} boardDate={boardDate} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="section-title">開催予定 ({dated.length})</h2>
        {byDay.size === 0 && later.length === 0 ? (
          <p className="section-lead">
            この先 {horizonDays} 日以内に、行ける範囲での開催予定はありませんでした。
          </p>
        ) : (
          <>
            <DateStrip days={days} countsByDay={countsByDay} today={boardDate} />
            {[...byDay.keys()].sort().map((key) => (
              <DayGroup
                key={key}
                meta={dayMeta(key, boardDate)}
                items={byDay.get(key) ?? []}
                boardDate={boardDate}
              />
            ))}
            {later.length > 0 && (
              <section className="dayblock">
                <h3 className="dayblock__head">
                  <span className="dayblock__rel">それ以降</span>
                </h3>
                <ul className="comm-list">
                  {later.map((item) => (
                    <AgendaRow key={item.id} item={item} boardDate={boardDate} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
