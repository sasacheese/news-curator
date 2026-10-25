import { resolveWindow } from './util.js';

/**
 * 朝のダイジェストを「その日 1 回だけ」出すための判定。
 *
 * 窓は resolveWindow と同じ [前日 cutoff, 当日 cutoff) JST。ここは時刻を
 * 動かさない。変えるのは、同じ日の 2 回目以降を収集・デプロイ・通知の
 * どれにも進ませないことだけ。
 *
 * ファイルの有無は呼び側が渡す。main の先端を見るのは CLI の仕事で、
 * この関数は時計とフラグだけで決める。
 */

export type DeliveryAction = 'collect' | 'redeploy' | 'skip';

export interface DeliveryInput {
  now: Date;
  /** github.event_name。schedule / workflow_dispatch / repository_dispatch 以外は壊れている扱い */
  event: string;
  /** 空や null は「時計から決める」。形式が違えば不正 */
  explicitDate?: string | null;
  /**
   * その日のファイルが既にあっても作り直す。
   * schedule では無視する。手動と外部起動だけが立てられる。
   */
  force?: boolean;
  /** 収集せず、今のツリーをデプロイだけする。workflow_dispatch だけが有効で、force より優先する */
  skipCollect?: boolean;
  /** data/digests/<date>.json が配信元ブランチの先端にある */
  digestOnMain: boolean;
  cutoffHour?: number;
}

export interface DeliveryDecision {
  action: DeliveryAction;
  /** 収集する日。不正な入力のときは空 */
  date: string;
  /** Pages へ出す */
  deploy: boolean;
  /** プッシュ通知を送る。deploy しても、再デプロイでは false */
  notify: boolean;
  /**
   * 呼び出し方が壊れている。既に配信済みで何もしない skip とは分けて、
   * CLI は fatal のときだけ失敗させる。
   */
  fatal: boolean;
  reason: string;
}

const KNOWN_EVENTS = new Set(['schedule', 'workflow_dispatch', 'repository_dispatch']);
const FORCE_EVENTS = new Set(['workflow_dispatch', 'repository_dispatch']);

/** 空は未指定。暦に無い日や桁の違う文字列は invalid */
export function normalizeExplicitDate(value: string | null | undefined): string | undefined | 'invalid' {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return 'invalid';
  const [y, m, d] = trimmed.split('-').map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d!));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m! - 1 || utc.getUTCDate() !== d) {
    return 'invalid';
  }
  return trimmed;
}

export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  const event = input.event.trim();
  const cutoffHour = input.cutoffHour ?? 7;
  const explicit = normalizeExplicitDate(input.explicitDate);

  if (explicit === 'invalid') {
    return fail('date が YYYY-MM-DD ではない');
  }
  if (!KNOWN_EVENTS.has(event)) {
    return fail('未対応のイベント');
  }

  const window = resolveWindow(input.now, explicit, cutoffHour);
  const date = window.date;
  const force = FORCE_EVENTS.has(event) && input.force === true;
  // 再デプロイは収集しないので、窓の開閉とは無関係。通知は出さない。
  const skipCollect = event === 'workflow_dispatch' && input.skipCollect === true;
  if (skipCollect) {
    return {
      action: 'redeploy',
      date,
      deploy: true,
      notify: false,
      fatal: false,
      reason: '収集をスキップして再デプロイする',
    };
  }

  // 終端ちょうどは窓が閉じている（半開区間の終わり）。それより前は出さない。
  if (input.now.getTime() < window.end.getTime()) {
    return {
      action: 'skip',
      date,
      deploy: false,
      notify: false,
      fatal: false,
      reason: 'ウィンドウがまだ閉じていない',
    };
  }

  if (input.digestOnMain && !force) {
    return {
      action: 'skip',
      date,
      deploy: false,
      notify: false,
      fatal: false,
      reason: 'その日のダイジェストは既にある',
    };
  }

  return {
    action: 'collect',
    date,
    deploy: true,
    notify: true,
    fatal: false,
    reason: input.digestOnMain ? 'force により作り直す' : 'その日のダイジェストがまだ無い',
  };
}

function fail(reason: string): DeliveryDecision {
  return { action: 'skip', date: '', deploy: false, notify: false, fatal: true, reason };
}

/**
 * ファイルが無い前提で日付を決め、収集することになったときだけ存在を聞く。
 * 窓が開いている日や再デプロイではディスクを見ない。
 */
export async function resolveDelivery(
  input: Omit<DeliveryInput, 'digestOnMain'>,
  digestExists: (date: string) => Promise<boolean>,
): Promise<DeliveryDecision> {
  const preview = decideDelivery({ ...input, digestOnMain: false });
  if (preview.action !== 'collect') return preview;
  const digestOnMain = await digestExists(preview.date);
  if (!digestOnMain) return preview;
  return decideDelivery({ ...input, digestOnMain: true });
}
