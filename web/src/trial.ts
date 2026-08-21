import { useEffect, useState } from 'react';
import { getFeedbackDb } from './firebase';
import type { TrialReport } from './types';

/**
 * 「サンドボックスで試させる」依頼の受け渡し。
 *
 * 静的サイトなのでブラウザから CI を直接起こせない。フィードバックと同じ Firestore を
 * **依頼の置き場**として使い、実行側（GitHub Actions）が定期的に見に来る。
 * GitHub の Issue を経由しない理由は体験のほうにある——この機能の目的は
 * 「読んだ流れのまま裏に投げて、あとで開いたら結果が待っている」ことなので、
 * 押した瞬間に別のアプリへ飛ぶ導線も、結果が Digest の外に出るのも成立しない。
 *
 * ⚠️ **依頼が運ぶのは鍵（日付 + 記事 ID）だけ。** 実行するコマンドは絶対に載せない。
 * 公開サイトから書ける置き場なので、コマンドを載せた瞬間にそれは「誰でも任意の
 * コマンドを CI で実行できる入口」になる。実行側は鍵で
 * `data/digests/<日付>.json`（リポジトリにコミット済み）を引き、そこに載っている
 * 項目の trial だけを実行する。title も表示のために持つが、実行側は信用しない。
 *
 * ⚠️ 値を増やしたら **Firestore のルールを先に公開**すること。ルールが許していない
 * フィールドや status を送ると書き込みが拒否され、失敗は console.warn に出るだけで
 * 画面には出ない（ボタンは押した見た目に変わる）。1 件も届かないまま気づけなくなる。
 */

export type TrialStatus = 'queued' | 'running' | 'done' | 'failed';

export interface TrialState {
  status: TrialStatus;
  /** 実行側が書く 1 行（結果の要約、または落ちた理由）。まだ無ければ null */
  note: string | null;
  /** 依頼した時刻（ミリ秒）。「25 分前に投げた」の表示にだけ使う */
  requestedAt: number | null;
}

const COLLECTION = 'trials';
const LOCAL_KEY = 'news-curator:trials';

/** 依頼の TTL。実行されずに溜まった依頼を Firestore 側の TTL で掃除する */
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 30;

/**
 * 依頼の鍵。日付を含めるのは、実行側がどのダイジェストを引けばいいかを
 * 鍵だけで決められるようにするため（記事 ID から日付を逆引きさせない）。
 */
export function trialKey(digestDate: string, itemId: string): string {
  return `${digestDate}__${itemId}`;
}

export interface TrialTarget {
  digestDate: string;
  itemId: string;
  /** 一覧や通知の表示用。実行側はこれを見ない */
  title: string;
}

/* ---------- この端末の控え ---------- */

/*
 * Firestore を読む前でも押した状態を出せるように、依頼をこの端末にも残す。
 * 実行の進み具合は持たない（それは Firestore が持つ）——ここにあるのは
 * 「自分が投げた」という事実と、経過時間を出すための時刻だけ。
 */
type LocalTrials = Record<string, number>;

function readLocal(): LocalTrials {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as LocalTrials;
  } catch {
    return {};
  }
}

export function readLocalTrial(key: string): number | null {
  return readLocal()[key] ?? null;
}

/**
 * この項目の控えを探す。試し直しで `-2` が付いた鍵も拾う。
 *
 * 基準の鍵だけを見ると、試し直したあとに「押していない」状態に見えてしまう。
 * 複数あるときは新しいほうを返す（最後の試行が今の状態）。
 */
export function findLocalTrial(baseKey: string): { key: string; at: number } | null {
  const map = readLocal();
  const hits = Object.entries(map)
    .filter(([k]) => k === baseKey || k.startsWith(`${baseKey}-`))
    .map(([key, at]) => ({ key, at }))
    .sort((a, b) => b.at - a.at);
  return hits[0] ?? null;
}

/**
 * 依頼が「置き場に無い」と分かってから、この端末の控えを消すまでの猶予。
 *
 * 押した直後は書き込みが届いていないことがあり、そこで消すと押した見た目が
 * 一瞬で戻ってしまう。実行は分単位なので、数分待って損はない。
 */
const GRACE_MS = 3 * 60_000;

/** 置き場に無いと分かったとき、この端末の控えを捨てていいか */
export function shouldForgetLocalTrial(localAt: number, now: number = Date.now()): boolean {
  return now - localAt > GRACE_MS;
}

/** 依頼が置き場から消えていたときに、この端末の控えも消す */
export function forgetLocalTrial(key: string): void {
  try {
    const map = readLocal();
    if (!(key in map)) return;
    delete map[key];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
  } catch {
    // localStorage が使えない環境では何もしない
  }
}

function writeLocalTrial(key: string, at: number): void {
  try {
    const map = readLocal();
    map[key] = at;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
  } catch {
    // localStorage が使えない環境では、その場の表示だけで諦める
  }
}

/* ---------- 依頼と状態 ---------- */

/**
 * 同じ項目を試し直すときの鍵の候補。
 *
 * **ルールは作成しか許していない**（ブラウザから `done` を書けないようにするため）。
 * その代わり、1 度失敗した項目は同じ鍵では置き直せない——`setDoc` が拒否され、
 * 失敗は console にしか出ないので、画面は「順番待ち」のまま永久に動かなくなる。
 *
 * そこで 2 回目以降は鍵の末尾に試行番号を付けて**新しい依頼として作る**。
 * ルールの正規表現（`__[A-Za-z0-9_-]{1,64}`）に収まるので、ルールの変更は要らない。
 * 記事 ID は 16 桁の 16 進数なので、`-2` が本物の ID と衝突することもない。
 *
 * 上限を置いているのは、拒否のたびに無限に鍵を増やさないため。ここに当たるのは
 * 「同じ項目を 5 回試した」ときだけで、そのときは素直に諦めて console に残す。
 */
export function attemptKeys(baseKey: string, max = 5): string[] {
  return [baseKey, ...Array.from({ length: max - 1 }, (_, i) => `${baseKey}-${i + 2}`)];
}

/**
 * 候補の鍵を順に試して、最初に作れたものを返す。作れなければ null。
 *
 * 「すでにある」と「本当に書けない」を区別しない（どちらもルール上は同じ拒否として
 * 返るため）。区別しなくても、次の鍵で作れれば目的は果たせる。
 */
export async function createFirstAvailable(
  keys: readonly string[],
  create: (key: string) => Promise<void>,
): Promise<string | null> {
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      await create(key);
      return key;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) console.warn('サンドボックスへの依頼に失敗しました', lastError);
  return null;
}

/**
 * 依頼を置く。置けた鍵を返す（失敗は null）。
 *
 * この端末の控えは**置けた鍵で**残す。試し直しで `-2` になったときに、
 * 状態の読み取り先とずれないようにするため。
 */
export async function requestTrial(target: TrialTarget): Promise<string | null> {
  const baseKey = trialKey(target.digestDate, target.itemId);

  /*
   * 控えを**先に**書く。書き込みの完了を待ってから書くと、その間にタブを閉じられた
   * ときに控えが残らない。次に開くとボタンが出て、押すと `-2` で新しい依頼が作られ、
   * **同じ項目に 2 回課金される**。Firestore の書き込みが失敗しても、控えが残るのは
   * 「押した」という事実なので害はない（置き場に無いと分かれば消える）。
   */
  writeLocalTrial(baseKey, Date.now());

  const db = await getFeedbackDb();
  if (!db) return null;

  const { doc, setDoc, serverTimestamp, Timestamp } = await import('firebase/firestore/lite');
  const key = await createFirstAvailable(attemptKeys(baseKey), (k) =>
    setDoc(doc(db, COLLECTION, k), {
      digestDate: target.digestDate,
      itemId: target.itemId,
      title: target.title,
      /*
       * 依頼の時点では必ず queued。実行側が running / done / failed へ進める。
       * クライアントから status を進められないよう、ルール側でも create 時の値を
       * queued に限定し、update は実行側（Admin SDK）だけに許すこと。
       */
      status: 'queued' satisfies TrialStatus,
      requestedAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RETENTION_DAYS * DAY_MS),
    }),
  );

  // 置けた鍵が基準と違うときだけ差し替える（読み取り先をずらさないため）
  if (key && key !== baseKey) writeLocalTrial(key, Date.now());
  return key;
}

/**
 * 状態を読む。
 *
 * 戻り値を 3 つに分けているのが要点。**「依頼が無い」と「読めなかった」を混ぜると、
 * この端末の控えがいつまでも「順番待ち」を出し続ける。** 依頼は 31 日で TTL に消され、
 * 失敗した依頼を消して押し直したいこともあるので、消えたことが分かる必要がある。
 *
 * - `TrialState` … 依頼がある
 * - `'missing'` … 置き場に無い（消された / TTL 切れ / まだ届いていない）
 * - `null` … 読めなかった（設定が無い・通信の失敗）。**控えは消さない**
 *
 * 購読（onSnapshot）はしない。firestore/lite に無いのもあるが、この機能で見たい
 * 変化は分単位で、開いたときに最新であれば足りる。
 */
export async function readTrialState(key: string): Promise<TrialState | 'missing' | null> {
  const db = await getFeedbackDb();
  if (!db) return null;
  try {
    const { doc, getDoc } = await import('firebase/firestore/lite');
    const snap = await getDoc(doc(db, COLLECTION, key));
    if (!snap.exists()) return 'missing';
    const d = snap.data() as {
      status?: unknown;
      note?: unknown;
      requestedAt?: { toMillis?: () => number };
    };
    return {
      status: isStatus(d.status) ? d.status : 'queued',
      note: typeof d.note === 'string' && d.note.trim() ? d.note.trim() : null,
      requestedAt: d.requestedAt?.toMillis?.() ?? null,
    };
  } catch (err) {
    console.warn('サンドボックスの状態の取得に失敗しました', err);
    return null;
  }
}

function isStatus(v: unknown): v is TrialStatus {
  return v === 'queued' || v === 'running' || v === 'done' || v === 'failed';
}

/* ------------------------------------------------------------------ *
 * 試した結果の読み込み
 * ------------------------------------------------------------------ */

/**
 * 盤面は日付を持たない 1 ファイルなので、**このタブを開いている間に 1 回だけ**読む。
 *
 * カードごとにフックを呼んでも取得は 1 回で済むよう、約束をモジュールに持つ
 * （firebase.ts が Firestore の初期化を 1 回に絞っているのと同じ形）。
 * まだ 1 件も試していないリポジトリでは 404 になるが、それは異常ではないので
 * 空の Map にする——この機能を使っていない fork では常にそうなる。
 */
let reportsPromise: Promise<Map<string, TrialReport>> | null = null;

function loadReports(): Promise<Map<string, TrialReport>> {
  if (!reportsPromise) {
    // 遅延 import。盤面を見ない画面（設定など）で api を引き込まないため
    reportsPromise = import('./api')
      .then((m) => m.loadTrialBoard())
      .then((board) => new Map(board.reports.map((r) => [r.key, r])))
      .catch(() => new Map<string, TrialReport>());
  }
  return reportsPromise;
}

export function useTrialReports(): Map<string, TrialReport> {
  const [reports, setReports] = useState<Map<string, TrialReport>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void loadReports().then((m) => {
      if (!cancelled) setReports(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return reports;
}
