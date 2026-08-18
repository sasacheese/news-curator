import type { LlmBackend } from './backend.js';
import type { RuntimeConfig } from './config.js';
import { complete, looksLikeOpinion } from './llm.js';
import type { CommunitySpeakResult } from './schemas.js';
import { CommunitySpeakResultSchema } from './schemas.js';
import type {
  CommunityAction,
  CommunityItem,
  CommunityScale,
  TopicsConfig,
} from './types.js';
import {
  cleanUrl,
  fetchJson,
  hashId,
  jstDateString,
  log,
  normalizeUrl,
  sleep,
  stripHtml,
  truncate,
} from './util.js';

/**
 * テックコミュニティの情報（イベント・登壇募集・もくもく会）を集める。
 *
 * 記事のパイプラインには載せない。SourceKind を増やすと dedupe / prescore / lanes が
 * 全部それを見ることになるが、イベントはその流れに入れない（開催まで毎日盤面に
 * 居るのが正しいので、重複排除で落としてはいけない）。advisories.ts が脆弱性で
 * そうしているのと同じく、RawItem を経由しない独立の入口にする。
 *
 * ここは全部ルールベースで API 費用はかからない。LLM を通すのは
 * 「登壇できる」の判定だけ（llm.ts 側）。connpass / Doorkeeper は日時・場所・定員を
 * 構造化データで持っているので、参加系に要約を通すと情報が減る。
 */

export interface CommunityConfig {
  enabled: boolean;
  /** 行ける範囲。もくもく会は物理的に行ける範囲でしか意味を持たない */
  location: { prefectures: string[]; online: boolean };
  /** 開催日を何日先まで見るか */
  horizonDays: number;
  /**
   * 締切を何日先まで見るか。horizonDays より長くする。
   *
   * 登壇は準備期間が要るので、締切の 3 週間前に初めて見えるのでは遅い。
   * 参加は当日行くだけなので 3 週間先まで見えれば足りる——同じ日数にすると、
   * どちらかが必ず合わない。
   */
  cfpHorizonDays: number;
  /** connpass / Doorkeeper の検索語 */
  keywords: string[];
  /** 母集団のノイズを機械的に落とす語（採用イベント・ビジネスセミナーなど） */
  exclude: string[];
  /**
   * 主催そのものを落とす。部分一致。
   *
   * ベンダーのウェビナー配信元は**サブドメインを分けて同じ内容を何本も出す**ので、
   * 「同じ主催は 1 件」の畳み込みをすり抜ける（実測で majisemi-operation /
   * -technology / -data が別主催として 3 件並んだ）。タイトルにも共通語が無いため、
   * ここで主催ごと落とすしかない。
   */
  excludeOrganizers: string[];
  /** confs.tech のどのトピックファイルを見るか */
  cfpTopics: string[];
  limits: Record<CommunityAction, number>;
}

/** ソースごとの差を吸収した中間形。ここから先の判定は全部これに対して行う */
export interface RawEvent {
  source: 'connpass' | 'doorkeeper' | 'confstech';
  sourceLabel: string;
  title: string;
  url: string;
  /** プレーンテキスト化した説明。判定に使うので HTML は落としておく */
  description: string;
  /** 主催コミュニティ。取れなければ null */
  organizer: string | null;
  startsAt: Date;
  endsAt: Date | null;
  place: string | null;
  address: string | null;
  limit: number | null;
  accepted: number | null;
  waiting: number | null;
  /** 構造化された CFP 締切。confs.tech だけが持つ */
  cfpEndsAt: Date | null;
  /** 開催国。海外の現地開催を落とすために持つ */
  country: string;
  /** オンライン開催であることがメタデータで確定しているもの（confs.tech の online） */
  onlineFlag: boolean;
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

/**
 * 登壇募集の検出。
 *
 * 「LT」の語だけで拾うと、LT を聞くだけの回や過去の LT 大会のレポートまで入る。
 * 募集していることが語のうえで確定しているものに絞る。ここは再現率優先で、
 * 「まだ募集しているか」の最終判定は LLM 側（community ステージ）で行う。
 */
const SPEAK_PATTERNS: RegExp[] = [
  /(登壇者?|発表者?|スピーカー|トーク|セッション|プロポーザル|LT)\s*[をの]?\s*(大?募集|募る|受付)/i,
  /(cfp|call\s*for\s*(papers?|proposals?|speakers?|talks?))/i,
  /(lt|ライトニングトーク)\s*(枠|登壇|発表)/i,
  /(登壇|発表)\s*(者|枠)?\s*(募集|受付|歓迎)/,
];

/**
 * もくもく会・作業会の検出。
 *
 * ここが十分に狭いので、この枠にはトピック一致を要求しない（§ pickAction）。
 */
const WORK_PATTERNS: RegExp[] = [/もくもく/i, /モクモク/, /黙々/, /作業会/, /朝活/, /自習室?会?/];

/**
 * カンファレンス相当の語。距離の免除条件になるので、広く取りすぎない。
 * 「Days」「Night」のような一般語は入れない（勉強会のタイトルに普通に出る）。
 */
const CONFERENCE_PATTERNS: RegExp[] = [
  /kaigi/i,
  // 先頭に \b を置くと JSConf / VimConf が落ちる（S や m と conf の間に境界が無い）。
  // 末尾の \b は残す——config / confluence を拾わないため
  /conf(erence)?\b/i,
  /\bsummit\b/i,
  /\bexpo\b/i,
  /isucon/i,
  /hack(a)?thon/i,
  /ハッカソン/,
  /カンファレンス/,
  /カンファ/,
  /技術祭|テックフェス|フェス/,
];

/** 定例回の印。連番が振られているものは単発のイベントではない */
const RECURRING_PATTERNS: RegExp[] = [/#\s*\d+/, /第\s*\d+\s*回/, /vol\.?\s*\d+/i];

const ONLINE_PATTERNS: RegExp[] = [
  /オンライン/,
  /\bonline\b/i,
  /\bzoom\b/i,
  /配信/,
  /リモート/,
  /\bdiscord\b/i,
  /ウェビナー/,
  /\bwebinar\b/i,
];

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

/**
 * 政令市などは住所に都道府県が省かれることがある（実測: Doorkeeper に
 * 「神戸市中央区…」「横浜駅東口近辺」がそのまま入っていた）。代表的なものだけ補う。
 */
const CITY_TO_PREFECTURE: Record<string, string> = {
  札幌: '北海道', 仙台: '宮城県', さいたま: '埼玉県', 千葉: '千葉県',
  横浜: '神奈川県', 川崎: '神奈川県', 相模原: '神奈川県', 新潟: '新潟県',
  静岡: '静岡県', 浜松: '静岡県', 名古屋: '愛知県', 京都: '京都府',
  大阪: '大阪府', 堺: '大阪府', 神戸: '兵庫県', 岡山: '岡山県',
  広島: '広島県', 北九州: '福岡県', 福岡: '福岡県', 熊本: '熊本県',
};

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** 判定に使う文字列。説明文は長いので頭だけ見る（末尾には過去回の告知が続く） */
function haystack(ev: RawEvent): string {
  return `${ev.title}\n${ev.description.slice(0, 1500)}`;
}

/**
 * 読者が今日取れる行動を決める。
 *
 * 「イベント情報」という 1 語に 3 つの別々のニーズが混ざっている。混ぜたまま出すと
 * 締切が今日の CFP と毎週のもくもく会が同じ行に並ぶ。
 */
export function pickAction(ev: RawEvent): CommunityAction {
  // confs.tech で CFP の締切を持っているものは、定義上登壇募集
  if (ev.cfpEndsAt) return 'speak';
  if (matchesAny(haystack(ev), SPEAK_PATTERNS)) return 'speak';
  // もくもく会に LT 募集が付いていることは稀なので、speak を先に見て構わない
  if (matchesAny(ev.title, WORK_PATTERNS)) return 'work';
  return 'attend';
}

/**
 * 規模。距離フィルタを緩める判断に使う。
 *
 * 近所しか出さないと TSKaigi / JSConf / ISUCON が構造的に落ち、全国を出すと
 * 行けないもくもく会で埋まる。規模が距離の免除条件になる。
 */
export function pickScale(ev: RawEvent): CommunityScale {
  if (matchesAny(ev.title, CONFERENCE_PATTERNS)) return 'conference';
  if ((ev.limit ?? 0) >= 200) return 'conference';
  if (ev.endsAt && jstDateString(ev.endsAt) !== jstDateString(ev.startsAt)) return 'conference';
  if (matchesAny(ev.title, WORK_PATTERNS) || matchesAny(ev.title, RECURRING_PATTERNS)) {
    return 'recurring';
  }
  return 'meetup';
}

export function detectVenue(ev: RawEvent): CommunityItem['venue'] {
  const where = `${ev.place ?? ''} ${ev.address ?? ''}`.trim();
  const online = ev.onlineFlag || matchesAny(`${ev.title} ${where}`, ONLINE_PATTERNS);

  let prefecture: string | null = PREFECTURES.find((p) => where.includes(p)) ?? null;
  if (!prefecture) {
    const city = Object.keys(CITY_TO_PREFECTURE).find((c) => where.includes(`${c}市`));
    if (city) prefecture = CITY_TO_PREFECTURE[city] ?? null;
  }

  // 場所が書かれていないものは現地扱いにしない。オンラインの語も無ければ判定を online に寄せる
  // （実測で Doorkeeper のウェビナーは place / address がどちらも空だった）
  const hasOnsite = Boolean(prefecture) || (where.length > 0 && !online);
  const mode = online && hasOnsite ? 'hybrid' : online ? 'online' : hasOnsite ? 'onsite' : 'online';

  return { mode, place: ev.place?.trim() || null, prefecture, country: ev.country };
}

/**
 * 行けるかどうか。
 *
 * know レーンが「トピック一致を門番にしない」のと同じ形の判断。
 * カンファレンスは距離を問わないが、**国内かオンライン**には限る。
 * 海外の現地開催は「大きいから知りたい」の範囲を超えるため。
 */
export function isReachable(
  scale: CommunityScale,
  venue: CommunityItem['venue'],
  location: CommunityConfig['location'],
): boolean {
  const online = venue.mode === 'online' || venue.mode === 'hybrid';
  if (online) return location.online;
  if (venue.country !== '日本') return false;
  if (scale === 'conference') return true;
  return venue.prefecture != null && location.prefectures.includes(venue.prefecture);
}

/** 採用イベント・ビジネスセミナーを機械的に落とす。タイトルだけを見る（本文まで見ると取りこぼす） */
export function isExcluded(ev: RawEvent, cfg: CommunityConfig): boolean {
  const title = ev.title.toLowerCase();
  if (cfg.exclude.some((k) => k && title.includes(k.toLowerCase()))) return true;

  const organizer = ev.organizer?.toLowerCase();
  if (!organizer) return false;
  return cfg.excludeOrganizers.some((k) => k && organizer.includes(k.toLowerCase()));
}

/**
 * 関心トピックとの一致。
 *
 * prescore の topicMatch と同じ考え方だが、対象が RawItem ではないので別に持つ。
 * タイトルに当たったものだけを matched に入れる（長い説明文には
 * スポンサー紹介や過去回の告知が続き、無関係なトピック名が付く）。
 */
export function matchTopics(ev: RawEvent, topics: TopicsConfig['topics']): string[] {
  const title = ev.title.toLowerCase();
  return topics
    .filter((topic) => topic.keywords.some((kw) => kw && title.includes(kw)))
    .map((topic) => topic.name);
}

/** 説明文が本文でトピックに触れているか。attend の門番をタイトルだけにすると狭すぎる */
function touchesTopics(ev: RawEvent, topics: TopicsConfig['topics']): boolean {
  const hay = `${ev.title} ${ev.description.slice(0, 1500)}`.toLowerCase();
  return topics.some((t) => t.keywords.some((k) => k && hay.includes(k)));
}

/** JST の暦日で数える。時刻差で数えると「今日締切」が 0 日と 1 日に揺れる */
export function daysUntil(target: Date, now: Date): number {
  const a = Date.parse(`${jstDateString(now)}T00:00:00Z`);
  const b = Date.parse(`${jstDateString(target)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* ------------------------------------------------------------------ *
 * 盤面の組み立て
 * ------------------------------------------------------------------ */

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.search(/[。！？!?]/);
  const head = cut > 0 ? flat.slice(0, cut + 1) : flat;
  return truncate(head, max);
}

function toItem(
  ev: RawEvent,
  action: CommunityAction,
  scale: CommunityScale,
  venue: CommunityItem['venue'],
  matchedTopics: string[],
  now: Date,
): CommunityItem {
  const deadline = ev.cfpEndsAt
    ? { kind: 'cfp' as const, at: ev.cfpEndsAt.toISOString(), daysLeft: daysUntil(ev.cfpEndsAt, now) }
    : null;

  return {
    id: hashId('community', normalizeUrl(ev.url)),
    action,
    title: ev.title.replace(/\s+/g, ' ').trim(),
    url: cleanUrl(ev.url),
    organizer: ev.organizer?.trim() || null,
    startsAt: ev.startsAt.toISOString(),
    endsAt:
      ev.endsAt && jstDateString(ev.endsAt) !== jstDateString(ev.startsAt)
        ? ev.endsAt.toISOString()
        : null,
    venue,
    deadline,
    scale,
    capacity:
      ev.limit == null && ev.accepted == null && ev.waiting == null
        ? null
        : { limit: ev.limit, accepted: ev.accepted, waiting: ev.waiting },
    what: firstSentence(ev.description, 60),
    // LLM を通す前は埋めない。中身の無い枠を作らない
    callFor: null,
    angles: [],
    isNew: false,
    sourceLabel: ev.sourceLabel,
    matchedTopics,
  };
}

const ACTION_ORDER: CommunityAction[] = ['speak', 'attend', 'work'];

/**
 * 同じ主催の複数回を 1 件に畳む（releases の mergeSameProduct と同じ形）。
 *
 * もくもく会は毎週同じ会が並ぶので当然だが、連番を振らずに毎週開かれるものも
 * 同じように並ぶ（実測で Doorkeeper の「Asana Refresh Morning（8月17日）」と
 * 「（8月24日）」が別のイベントとして 2 件出た）。scale では捕まらないので、
 * 主催が同じなら直近の 1 回だけ残す。
 *
 * 呼び出し前に開催日の昇順にしておくこと。主催が取れないものは畳まない。
 */
function collapseSameOrganizer(items: CommunityItem[]): CommunityItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.organizer) return true;
    const key = `${item.action}::${item.organizer.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortWithin(action: CommunityAction, items: CommunityItem[]): CommunityItem[] {
  return [...items].sort((a, b) => {
    if (action === 'speak') {
      // 締切が本体。持っているものを先に、近い順に
      const ad = a.deadline?.daysLeft ?? Number.POSITIVE_INFINITY;
      const bd = b.deadline?.daysLeft ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
    }
    return a.startsAt.localeCompare(b.startsAt);
  });
}

/**
 * 収集した生イベントから盤面を作る。ここが絞り込みの本体で、全部ルールベース。
 *
 * @param previousIds 前日のダイジェストに載っていた id。差分（isNew）を出すために使う
 */
export function buildBoard(
  events: RawEvent[],
  cfg: CommunityConfig,
  topics: TopicsConfig,
  now: Date,
  previousIds: ReadonlySet<string>,
): CommunityItem[] {
  const dropped = { window: 0, excluded: 0, distance: 0, topic: 0 };
  const byUrl = new Map<string, CommunityItem>();

  for (const ev of events) {
    /*
     * ① 期間。開催日か締切のどちらかが範囲に入れば拾う。
     * 締切のほうを優先して見るのが要点で、「開催は 3 か月後だが締切は明日」の CFP が
     * この枠でいちばん行動価値が高い。開催日だけで切ると落ちる。
     */
    const untilStart = daysUntil(ev.startsAt, now);
    const untilDeadline = ev.cfpEndsAt ? daysUntil(ev.cfpEndsAt, now) : null;
    const startInRange = untilStart >= 0 && untilStart <= cfg.horizonDays;
    const deadlineInRange =
      untilDeadline != null && untilDeadline >= 0 && untilDeadline <= cfg.cfpHorizonDays;
    if (!startInRange && !deadlineInRange) {
      dropped.window++;
      continue;
    }
    // 締切が過ぎた登壇募集は価値がゼロなので、開催が先でも出さない
    if (untilDeadline != null && untilDeadline < 0) {
      dropped.window++;
      continue;
    }

    if (isExcluded(ev, cfg)) {
      dropped.excluded++;
      continue;
    }

    const action = pickAction(ev);
    const scale = pickScale(ev);
    const venue = detectVenue(ev);

    // ② 距離。規模で緩める
    if (!isReachable(scale, venue, cfg.location)) {
      dropped.distance++;
      continue;
    }

    /*
     * ③ 関心一致。attend にだけ掛ける。
     *
     * - speak: 登壇機会は「関心があるか」ではなく「話せる題材を持っているか」で決まる。
     *   一致を門番にすると、話せるのに語彙に無いイベントが落ちる。
     * - work: 「もくもく」の判定自体が十分に狭い。もくもく会のタイトルに
     *   React や TypeScript は出てこないので、一致を要求すると枠が空になる。
     * - attend: ここだけ母集団がビジネスセミナー・採用イベントで埋まるので必須。
     */
    if (action === 'attend' && !touchesTopics(ev, topics.topics)) {
      dropped.topic++;
      continue;
    }

    const item = toItem(ev, action, scale, venue, matchTopics(ev, topics.topics), now);
    // 同じイベントが 2 つのソースに出ることがある。構造化データが厚い connpass を残す
    const key = normalizeUrl(item.url);
    const existing = byUrl.get(key);
    if (existing && existing.sourceLabel.startsWith('connpass')) continue;
    byUrl.set(key, item);
  }

  const out = ACTION_ORDER.flatMap((action) => {
    // 畳み込みは並べ替えのあと。どれを代表に残すかが並び順で決まる
    const sorted = sortWithin(action, [...byUrl.values()].filter((i) => i.action === action));
    const list = collapseSameOrganizer(sorted);
    const limit = cfg.limits[action] ?? list.length;
    if (list.length > limit) {
      log.info(`  ${action}: ${list.length} 件から ${limit} 件に絞りました`);
    }
    return list.slice(0, limit);
  });

  log.info(
    `  コミュニティ: ${out.length} 件` +
      `（候補 ${events.length} → 期間外 ${dropped.window} / 除外語 ${dropped.excluded} / ` +
      `行けない ${dropped.distance} / 関心外 ${dropped.topic}）`,
  );

  /*
   * 前日に無かったものへ印を付ける。毎日同じ盤面を眺めることになるので、
   * 差分が見えるかどうかがこのセクションの読みやすさを決める。
   * 前日のデータが無い日は全件 false にする（初日に全部 NEW が付くと目印として死ぬ）。
   */
  if (previousIds.size === 0) return out;
  return out.map((item) => ({ ...item, isNew: !previousIds.has(item.id) }));
}

/* ------------------------------------------------------------------ *
 * connpass
 * ------------------------------------------------------------------ */

interface ConnpassEvent {
  event_id: number;
  title: string;
  catch?: string | null;
  description?: string | null;
  event_url?: string | null;
  url?: string | null;
  started_at: string;
  ended_at?: string | null;
  limit?: number | null;
  accepted?: number | null;
  waiting?: number | null;
  place?: string | null;
  address?: string | null;
  group?: { title?: string | null } | null;
  series?: { title?: string | null } | null;
}

/** YYYYMM を n か月ぶん、当月から並べる */
function months(now: Date, count: number): string[] {
  const out: string[] = [];
  const [y, m] = jstDateString(now).split('-').map(Number) as [number, number];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * connpass API v2。
 *
 * **開催月（ym）で引く。公開ウィンドウでは引かない。** イベントは開催日が本体なので、
 * 「いつ告知されたか」で絞ると締切が近い告知済みのものが落ちる。
 *
 * API キーは必須で、個人・コミュニティ利用は申請すれば無償。未設定なら黙って
 * 空を返す（呼び出し側が notes に 1 行足す）。
 *
 * **呼び出し頻度は「5 秒に 1 リクエスト」を超えないこと**（connpass の robots.txt
 * 由来の条件で、API の利用申請でも明示されている）。1 日 1 回・2 か月ぶんの
 * 計 2 リクエストしか投げないので、間隔さえ守れば余裕で収まる。
 */
const CONNPASS_INTERVAL_MS = 5_000;
export async function collectConnpass(
  cfg: CommunityConfig,
  apiKey: string | undefined,
  now: Date,
): Promise<RawEvent[]> {
  if (!apiKey) return [];

  const out: RawEvent[] = [];
  const keyword = cfg.keywords.map((k) => `keyword_or=${encodeURIComponent(k)}`).join('&');

  for (const ym of months(now, 2)) {
    const url = `https://connpass.com/api/v2/events/?${keyword}&ym=${ym}&count=100&order=2`;
    try {
      const data = await fetchJson<{ events?: ConnpassEvent[] }>(url, {
        headers: { 'x-api-key': apiKey },
      });
      for (const e of data.events ?? []) {
        const eventUrl = e.event_url || e.url;
        if (!eventUrl) continue;
        out.push({
          source: 'connpass',
          sourceLabel: 'connpass',
          title: e.title,
          url: eventUrl,
          description: `${e.catch ?? ''}\n${stripHtml(e.description ?? '')}`.trim(),
          organizer: e.group?.title ?? e.series?.title ?? null,
          startsAt: new Date(e.started_at),
          endsAt: e.ended_at ? new Date(e.ended_at) : null,
          place: e.place ?? null,
          address: e.address ?? null,
          limit: e.limit ?? null,
          accepted: e.accepted ?? null,
          waiting: e.waiting ?? null,
          cfpEndsAt: null,
          country: '日本',
          onlineFlag: false,
        });
      }
    } catch (err) {
      log.warn(`connpass(${ym}): ${err instanceof Error ? err.message : err}`);
    }
    await sleep(CONNPASS_INTERVAL_MS);
  }

  log.info(`  connpass: ${out.length} 件`);
  return out;
}

/* ------------------------------------------------------------------ *
 * Doorkeeper
 * ------------------------------------------------------------------ */

interface DoorkeeperEvent {
  title: string;
  id: number;
  starts_at: string;
  ends_at?: string | null;
  venue_name?: string | null;
  address?: string | null;
  description?: string | null;
  public_url: string;
  participants?: number | null;
  waitlisted?: number | null;
  ticket_limit?: number | null;
}

/**
 * 主催名の代わりにサブドメインを使う。
 *
 * events のレスポンスに入っている group は数値 ID で、名前を引くには
 * 追加リクエストが要る。サブドメインはそのコミュニティ自身が付けた識別子なので、
 * 定例回を畳むキーとしてはこれで足りる。
 */
function doorkeeperOrganizer(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const sub = host.replace(/\.doorkeeper\.jp$/, '');
    return sub && sub !== 'www' && sub !== host ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Doorkeeper API。
 *
 * 公式ドキュメントは Public API Access Token 必須と書いているが、実測では
 * 未認証で 200 が返る。将来閉じられる前提で、token があれば付ける。
 *
 * 注意: ここの母集団は connpass より 1 桁小さく、しかもビジネスセミナーが多い
 * （実測 25 件中、技術イベントは 2 件）。検索語で引いたうえで、
 * attend にはトピック一致の門番が必須。
 */
export async function collectDoorkeeper(
  cfg: CommunityConfig,
  token: string | undefined,
  now: Date,
): Promise<RawEvent[]> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const since = jstDateString(now);
  const byUrl = new Map<string, RawEvent>();

  for (const kw of cfg.keywords) {
    const url =
      `https://api.doorkeeper.jp/events?locale=ja&sort=starts_at` +
      `&q=${encodeURIComponent(kw)}&since=${since}`;
    try {
      const list = await fetchJson<{ event: DoorkeeperEvent }[]>(url, { headers });
      for (const { event: e } of list ?? []) {
        if (!e?.public_url) continue;
        byUrl.set(e.public_url, {
          source: 'doorkeeper',
          sourceLabel: 'Doorkeeper',
          title: e.title,
          url: e.public_url,
          description: stripHtml(e.description ?? ''),
          organizer: doorkeeperOrganizer(e.public_url),
          startsAt: new Date(e.starts_at),
          endsAt: e.ends_at ? new Date(e.ends_at) : null,
          place: e.venue_name ?? null,
          address: e.address ?? null,
          limit: e.ticket_limit ?? null,
          accepted: e.participants ?? null,
          waiting: e.waitlisted ?? null,
          cfpEndsAt: null,
          country: '日本',
          onlineFlag: false,
        });
      }
    } catch (err) {
      log.warn(`doorkeeper(${kw}): ${err instanceof Error ? err.message : err}`);
    }
    await sleep(500);
  }

  log.info(`  Doorkeeper: ${byUrl.size} 件`);
  return [...byUrl.values()];
}

/* ------------------------------------------------------------------ *
 * confs.tech（カンファレンスの CFP）
 * ------------------------------------------------------------------ */

interface ConfsTechEntry {
  name: string;
  url: string;
  startDate: string;
  endDate?: string | null;
  city?: string | null;
  country?: string | null;
  online?: boolean;
  cfpUrl?: string | null;
  cfpEndDate?: string | null;
}

/**
 * confs.tech のデータ（tech-conferences/conference-data）から CFP を拾う。
 * 認証は要らず、GitHub の raw を読むだけ。
 *
 * ⚠️ **海外中心のデータで、日本のカンファレンスはほとんど入っていない。**
 * 実効性は「オンライン登壇できる海外 CFP」まで。日本の CFP はカンファレンス公式
 * ブログの RSS（watchlist.feeds）と connpass 側で拾う。薄い枠だと分かって入れている。
 */
export async function collectCfp(cfg: CommunityConfig, now: Date): Promise<RawEvent[]> {
  const year = Number(jstDateString(now).slice(0, 4));
  const out: RawEvent[] = [];
  let missing = 0;

  for (const y of [year, year + 1]) {
    for (const topic of cfg.cfpTopics) {
      const url =
        `https://raw.githubusercontent.com/tech-conferences/conference-data/main` +
        `/conferences/${y}/${topic}.json`;
      let list: ConfsTechEntry[];
      try {
        list = await fetchJson<ConfsTechEntry[]>(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /*
         * 翌年のファイルは年の途中まで存在しない。毎日 404 が何行も出ると
         * 本当の異常が埋もれるので、404 は件数だけ最後にまとめる。
         */
        if (message.includes('HTTP 404')) missing++;
        else log.warn(`  confs.tech(${y}/${topic}): ${message}`);
        continue;
      }
      if (!Array.isArray(list)) continue;

      for (const c of list) {
        if (!c?.cfpEndDate || !c.url || !c.startDate) continue;
        const cfpEndsAt = new Date(`${c.cfpEndDate}T23:59:59+09:00`);
        if (Number.isNaN(cfpEndsAt.getTime())) continue;
        out.push({
          source: 'confstech',
          sourceLabel: 'confs.tech',
          title: c.name,
          url: c.cfpUrl || c.url,
          description: `${c.name} の登壇者募集（${c.city ?? ''} ${c.country ?? ''}）`.trim(),
          organizer: c.name,
          startsAt: new Date(`${c.startDate}T00:00:00+09:00`),
          endsAt: c.endDate ? new Date(`${c.endDate}T00:00:00+09:00`) : null,
          place: c.city ?? null,
          address: null,
          limit: null,
          accepted: null,
          waiting: null,
          cfpEndsAt,
          country: c.country === 'Japan' ? '日本' : (c.country ?? '不明'),
          onlineFlag: c.online === true,
        });
      }
    }
  }

  log.info(
    `  confs.tech: ${out.length} 件（CFP 締切を持つもの）` +
      (missing > 0 ? ` / ${missing} ファイルは未作成` : ''),
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * まとめ
 * ------------------------------------------------------------------ */

export interface CommunityResult {
  items: CommunityItem[];
  /** connpass のキーが無くて縮退したか。notes に出すために返す */
  degraded: boolean;
}

export async function collectCommunity(
  cfg: CommunityConfig,
  topics: TopicsConfig,
  previousIds: ReadonlySet<string>,
  backend: LlmBackend | null,
  runtime: RuntimeConfig,
  now = new Date(),
): Promise<CommunityResult> {
  if (!cfg.enabled) return { items: [], degraded: false };

  const connpassKey = process.env.CONNPASS_API_KEY?.trim();
  const groups = await Promise.all([
    collectConnpass(cfg, connpassKey, now).catch(() => []),
    collectDoorkeeper(cfg, process.env.DOORKEEPER_TOKEN?.trim(), now).catch(() => []),
    collectCfp(cfg, now).catch(() => []),
  ]);

  const events = groups.flat();
  const board = buildBoard(events, cfg, topics, now, previousIds);

  // 説明文は保存しないので、判定に渡すぶんだけ URL で引き当てる
  const descriptions = new Map(events.map((e) => [normalizeUrl(e.url), e.description]));
  const items = await judgeSpeakItems(board, descriptions, backend, topics, runtime, now);

  return { items, degraded: !connpassKey };
}

/* ------------------------------------------------------------------ *
 * 「登壇できる」の判定（LLM を通すのはここだけ）
 * ------------------------------------------------------------------ */

function speakSystemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡されたイベントについて「いま登壇者を募集しているか」を判定し、募集していれば
募集の内容と、この読者が出せる題材を書いてください。

# 読者プロフィール
${topics.profile}

# isOpen の判定
一番重要な判定です。**募集していないものを募集中として出すのが最悪の壊れ方**なので、
迷ったら false にしてください。

false にするもの:
- 過去の登壇募集の報告・登壇レポート
- LT や発表を「聞く」だけの回
- 締切が既に過ぎている募集
- 登壇ではなく「参加者」の募集
- 運営スタッフ・スポンサーの募集

# callFor
何を何枠募集しているかを、原文の数字のまま書きます。
- 良い例: 「LT 5分 × 6枠」「トーク 20分 / 40分」「セッション 30分 × 4枠」
- 本文から読み取れなければ null。枠数を推測して埋めないこと。

# deadlineAt
応募の締切を YYYY-MM-DD で。本文に無ければ null にしてください。
**開催日を締切として代用しないこと。**

# angles（この読者が出せる題材）
読者プロフィールの技術スタックと、そのイベントの主題が重なるところを
**名詞句だけ**で並べます。**文にしないこと。**

- 良い例: 「Server Components の実務での落とし所」
- 良い例: 「AI エージェント併用時のレビュー負荷の実測」
- 悪い例: 「Server Components は実務では扱いにくいと思う」（意見の代筆）
- 悪い例: 「React について発表しましょう」（題材になっていない）

重なりが無ければ空配列にしてください。埋めるために一般論を書かないこと。

# 出力
入力されたすべての ref に対して、必ず1件ずつ結果を返してください。
isOpen が false のものも ref を返します（他の項目は null / 空配列で構いません）。`;
}

/**
 * ルールベースで拾った「登壇できる」を LLM で絞る。
 *
 * ここだけ LLM を通す理由は 2 つある。
 * - 「LT 枠がある」はイベント説明の本文に埋まっていて、構造化データに無い
 * - ルールベースだと過去の LT 大会のレポートや「LT を聞く回」まで拾ってしまう
 *
 * バックエンドが無い日は、判定できないので **speak 枠ごと落とす**。
 * 募集していないものを「登壇できる」として並べるのが、この枠で一番まずい壊れ方。
 * 参加系はそのまま残るので、セクション自体は成立する。
 */
export async function judgeSpeakItems(
  board: CommunityItem[],
  descriptions: ReadonlyMap<string, string>,
  backend: LlmBackend | null,
  topics: TopicsConfig,
  cfg: RuntimeConfig,
  now: Date,
): Promise<CommunityItem[]> {
  const speak = board.filter((i) => i.action === 'speak');
  const rest = board.filter((i) => i.action !== 'speak');
  if (speak.length === 0) return board;

  if (!backend) {
    log.warn(
      `  LLM が無いため「登壇できる」${speak.length} 件を保留しました` +
        '（募集が続いているか判定できないため）。',
    );
    return rest;
  }

  const body = speak
    .map((item, ref) => {
      const excerpt = truncate(
        (descriptions.get(normalizeUrl(item.url)) ?? item.what).replace(/\s+/g, ' ').trim(),
        700,
      );
      return [
        `[${ref}] ${item.title}`,
        `  開催: ${item.startsAt.slice(0, 10)}`,
        item.deadline ? `  既知の締切: ${item.deadline.at.slice(0, 10)}` : null,
        `  抜粋: ${excerpt || '(本文なし)'}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  let parsed: CommunitySpeakResult;
  try {
    parsed = await complete(backend, {
      stage: 'community',
      model: cfg.rankModel,
      maxTokens: 4000,
      system: speakSystemPrompt(topics),
      prompt: `以下 ${speak.length} 件を判定してください。\n\n${body}`,
      schema: CommunitySpeakResultSchema,
    });
  } catch (err) {
    log.warn(`登壇機会の判定失敗: ${err instanceof Error ? err.message : err}`);
    return rest;
  }

  const judged: CommunityItem[] = [];
  for (const r of parsed.items ?? []) {
    const item = speak[r.ref];
    if (!item || !r.isOpen) continue;

    const deadlineAt = parseDeadline(r.deadlineAt);
    // 締切が読めたら差し替える。過ぎているものはここで落ちる
    const deadline = deadlineAt
      ? { kind: 'cfp' as const, at: deadlineAt.toISOString(), daysLeft: daysUntil(deadlineAt, now) }
      : item.deadline;
    if (deadline && deadline.daysLeft < 0) continue;

    judged.push({
      ...item,
      deadline,
      callFor: r.callFor?.trim() || null,
      // 文で返ってきたものは発表の代筆なので落とす（talk レーンと同じ判定を共有）
      angles: (r.angles ?? [])
        .map((a) => a.trim())
        .filter(Boolean)
        .filter((a) => !looksLikeOpinion(a))
        .slice(0, 3),
    });
  }

  log.info(`  登壇できる: ${judged.length}/${speak.length} 件が募集中`);
  return [...sortWithin('speak', judged), ...rest];
}

function parseDeadline(raw: string | null | undefined): Date | null {
  const t = raw?.trim();
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  // 締切は「その日いっぱい」で扱う
  const d = new Date(`${t}T23:59:59+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
