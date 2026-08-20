import { getFeedbackDb } from './firebase';

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

/** 依頼を置く。置けたら true。失敗は画面に出さず console にだけ残す */
export async function requestTrial(target: TrialTarget): Promise<boolean> {
  const key = trialKey(target.digestDate, target.itemId);
  writeLocalTrial(key, Date.now());

  const db = await getFeedbackDb();
  if (!db) return false;
  try {
    const { doc, setDoc, serverTimestamp, Timestamp } = await import('firebase/firestore/lite');
    await setDoc(doc(db, COLLECTION, key), {
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
    });
    return true;
  } catch (err) {
    console.warn('サンドボックスへの依頼に失敗しました', err);
    return false;
  }
}

/**
 * 状態を読む。まだ依頼が無ければ null。
 *
 * 購読（onSnapshot）はしない。firestore/lite に無いのもあるが、この機能で見たい
 * 変化は分単位で、開いたときに最新であれば足りる。呼び出し側は表示時と
 * ウィンドウに戻ってきたときだけ読む。
 */
export async function readTrialState(key: string): Promise<TrialState | null> {
  const db = await getFeedbackDb();
  if (!db) return null;
  try {
    const { doc, getDoc } = await import('firebase/firestore/lite');
    const snap = await getDoc(doc(db, COLLECTION, key));
    if (!snap.exists()) return null;
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
