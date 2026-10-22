import type { RuntimeConfig } from './config.js';
import {
  type ToolCandidate,
  applyStateUpdates,
  archiveStale,
  buildToolBoard,
  mergeCandidates,
  toolIdOf,
} from './tools.js';
import { describeTools } from './tools-describe.js';
import { candidatesFromCollected, candidatesFromDigest, candidatesFromRadar } from './tools-intake.js';
import { clearInbox, loadInbox, loadToolStates, logInbox, resolveInboxUrl } from './tools-inbox.js';
import { inspectPending } from './tools-inspect.js';
import { type ToolSourcesConfig, collectToolSources } from './tools-sources.js';
import { buildTryPrompt, otherQuestions } from './try-prompt.js';
import type { Digest, RadarBoard, RawItem, ToolBoard, ToolEntry, ToolIdentity, ToolLedger } from './types.js';
import { log, mapLimit, normalizeUrl, safe } from './util.js';

/** 1 回の実行で GitHub / npm を調べる道具の上限（1 道具 2〜3 リクエスト） */
const INSPECT_BUDGET = 120;
/** 1 回の実行で LLM に要約させる道具の上限 */
const DESCRIBE_BUDGET = 90;

export interface ToolboxInput {
  date: string;
  windowStart: Date;
  digest: Digest;
  collected: readonly RawItem[];
  radar: RadarBoard | null | undefined;
  ledger: ToolLedger;
  sources: ToolSourcesConfig;
  runtime: RuntimeConfig;
}

function tryPromptOf(entry: ToolEntry): string | null {
  const identity = entry.identity.npm
    ? { npmPackage: entry.identity.npm }
    : entry.identity.github
      ? { githubRepo: entry.identity.github }
      : null;
  return buildTryPrompt(identity, {
    goal: `${entry.name} を動かして、README の最初の出力まで到達する`,
    url: entry.homepage,
    questions: otherQuestions(),
  });
}

export async function runToolbox(input: ToolboxInput): Promise<{ ledger: ToolLedger; board: ToolBoard }> {
  const { date } = input;
  const notes: string[] = [];

  const knownKeys = new Set<string>();
  for (const t of Object.values(input.ledger.tools)) {
    if (t.identity.github) knownKeys.add(`gh:${t.identity.github.toLowerCase()}`);
    if (t.identity.npm) knownKeys.add(`npm:${t.identity.npm.toLowerCase()}`);
    if (t.identity.url) knownKeys.add(`url:${normalizeUrl(t.identity.url)}`);
  }
  const known = (id: ToolIdentity) => {
    const key = toolIdOf(id);
    return key != null && knownKeys.has(key);
  };

  /* 入口 ------------------------------------------------------------- */
  const fromSources = await collectToolSources(input.sources, {
    date,
    windowStart: input.windowStart,
    known,
  });
  const candidates: ToolCandidate[] = [
    ...candidatesFromDigest(input.digest),
    ...candidatesFromCollected(input.collected, date),
    ...candidatesFromRadar(input.radar, date),
    ...fromSources,
  ];

  // 手で追加したもの。受付は処理したら消す（失敗したものも消す——毎朝同じ URL で失敗し続けないため）
  const inbox = await safe('tools:inbox', () => loadInbox(), []);
  const manual = (
    await mapLimit(inbox, 4, (e) => safe(`tools:inbox(${e.url})`, () => resolveInboxUrl(e.url, date), null))
  ).filter((c): c is ToolCandidate => c != null);
  logInbox(inbox.length, manual.length);
  if (inbox.length > manual.length) {
    notes.push(`貼られた URL のうち ${inbox.length - manual.length} 件は道具として登録できませんでした。`);
  }

  const merged = mergeCandidates(input.ledger, [...candidates, ...manual], date);
  let ledger = merged.ledger;

  /* 読者の操作 -------------------------------------------------------- */
  // 手で追加したものは、それだけで「気になる」とみなす（貼ったのは触りたいから）
  const manualIds = merged.ids.slice(candidates.length).filter((id): id is string => id != null);
  const states = await safe('tools:state', () => loadToolStates(), []);
  ledger = applyStateUpdates(ledger, [
    ...manualIds.map((id) => ({ id, state: 'interested' as const, at: `${date}T00:00:00.000Z` })),
    ...states,
  ]);
  await safe('tools:inbox-clear', () => clearInbox(inbox.map((e) => e.docId)), undefined);

  /* 調べる・要約する --------------------------------------------------- */
  const inspected = await inspectPending(ledger.tools, INSPECT_BUDGET);
  ledger = { ...ledger, tools: inspected.tools };

  const toDescribe = Object.values(ledger.tools)
    .filter((t) => !t.described && t.state !== 'archived' && t.state !== 'passed')
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1))
    .slice(0, DESCRIBE_BUDGET);
  const described = await describeTools(toDescribe, input.runtime);
  const tools = { ...ledger.tools };
  for (const t of toDescribe) {
    const d = described.get(t.id);
    tools[t.id] = {
      ...t,
      // バックエンドが無い日（ローカル）は「試みた」にしない。次の実行で書けるように残す
      described: described.size > 0 || t.described,
      ...(d
        ? {
            summary: d.summary,
            replaces: d.replaces,
            requires: [...new Set([...t.requires, ...d.requires])],
          }
        : {}),
    };
  }
  ledger = { ...ledger, tools };

  /* 退避・盤面 -------------------------------------------------------- */
  const archived = archiveStale(ledger, date);
  ledger = { ...archived.ledger, updatedAt: new Date().toISOString() };

  log.info(
    `  [道具] 候補 ${candidates.length + manual.length} / 新規 ${merged.added.length}` +
      ` / 再浮上 ${merged.resurfaced.length} / 退避 ${archived.archived.length}` +
      ` / 調査 ${inspected.inspected} / 要約 ${described.size}/${toDescribe.length}`,
  );

  const board = buildToolBoard(ledger, date, {
    addedToday: merged.added.length,
    resurfacedToday: merged.resurfaced.length,
    notes,
    tryPromptOf,
  });
  return { ledger, board };
}
