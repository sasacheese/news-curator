import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type { AuthorDetail, Metrics, RawItem } from './types.js';
import {
  cleanUrl,
  detectLang,
  hashId,
  isHttpUrl,
  jstDateString,
  log,
  normalizeUrl,
  truncate,
} from './util.js';
import type { Window } from './sources.js';

/**
 * 外部からコミットされる取り込みファイル。
 *
 * 日次の収集は [前日 07:00, 当日 07:00) JST だけを見る。ファイルはダイジェスト日
 * （ウィンドウ終端の JST 日付）の朝、07:00 より前に置かれる。投稿がその時刻まで
 * 含まれていても、半開区間でその日のウィンドウに一度だけ入る。翌日の実行は
 * 同じファイルを「前日分」として開くが、publishedAt が新しいウィンドウの外なので
 * もう一度は拾わない。
 *
 * ファイルが無い・壊れている・中の 1 件が不正、のいずれでも収集全体は止めない。
 */

const INBOX_DIR = resolve(DATA_DIR, 'inbox');
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const PUBLISHED_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const METRIC_KEYS = ['likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'impressions'] as const;
const NOTE_LIMIT = 8;

export interface IngestResult {
  items: RawItem[];
  notes: string[];
}

/**
 * このウィンドウで開くファイルの日付。
 *
 * 終端の直前の JST 日付（ダイジェスト日）と、開始時刻の JST 日付。
 * 投稿が「ダイジェスト日」のファイルに入っていても、「投稿日」のファイルに
 * 入っていても、publishedAt がウィンドウ内ならどちらか一方の実行で拾える。
 */
export function inboxFileDates(w: Window): string[] {
  const endDay = jstDateString(new Date(w.end.getTime() - 1));
  const startDay = jstDateString(w.start);
  return endDay === startDay ? [endDay] : [endDay, startDay];
}

/** 題の無い投稿の見出し。作者と本文の最初の非空行。 */
export function postTitle(author: string, text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const flat = firstLine.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
  return clipped ? `${author}: ${clipped}` : author;
}

function fileLabel(date: string): string {
  return `data/inbox/${date}.json`;
}

function pushNote(notes: string[], note: string): void {
  notes.push(note);
}

async function readItems(date: string, dir: string, notes: string[]): Promise<unknown[] | null> {
  const label = fileLabel(date);
  let raw: string;
  try {
    raw = await readFile(resolve(dir, `${date}.json`), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    pushNote(notes, `${label}: 読めませんでした（${err instanceof Error ? err.message : err}）`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    pushNote(notes, `${label}: JSON として解釈できないためスキップしました`);
    return [];
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return (parsed as { items: unknown[] }).items;
  }
  pushNote(notes, `${label}: items 配列が無いためスキップしました`);
  return [];
}

function parsePublishedAt(value: unknown): Date | null {
  if (typeof value !== 'string' || !PUBLISHED_AT.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function xHandle(value: string): string | null {
  const handle = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function parseAuthor(value: unknown): { label: string; author: string; detail?: AuthorDetail } | null {
  if (typeof value === 'string') {
    const handle = xHandle(value);
    if (!handle) return null;
    return {
      label: `@${handle}`,
      author: handle,
      detail: { name: handle, handle: `@${handle}`, url: `https://x.com/${handle}` },
    };
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as { handle?: unknown; name?: unknown };
  const handle = typeof record.handle === 'string' ? xHandle(record.handle) : null;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!handle && !name) return null;
  if (typeof record.handle === 'string' && record.handle.trim() && !handle) return null;
  const label = handle ? `@${handle}` : name;
  return {
    label,
    author: name || handle!,
    detail: {
      name: name || handle!,
      ...(handle ? { handle: `@${handle}`, url: `https://x.com/${handle}` } : {}),
    },
  };
}

function parseMetrics(value: unknown, label: string, notes: string[]): Metrics | null {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    pushNote(notes, `${label}: metrics がオブジェクトではないためスキップしました`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const metrics: Metrics = {};
  for (const key of METRIC_KEYS) {
    if (record[key] == null) continue;
    const n = record[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      pushNote(notes, `${label}: metrics.${key} が 0 以上の数ではないためスキップしました`);
      return null;
    }
    metrics[key] = n;
  }
  // 返信は comments に相当する。
  if (metrics.replies != null) metrics.comments = metrics.replies;
  return metrics;
}

function parseLinks(value: unknown, label: string, notes: string[]): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    pushNote(notes, `${label}: links が配列ではないためスキップしました`);
    return null;
  }
  const links: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isHttpUrl(entry.trim())) {
      pushNote(notes, `${label}: 不正なリンクを落としました (${JSON.stringify(entry)})`);
      continue;
    }
    links.push(entry.trim());
  }
  return links;
}

function parseItem(value: unknown, label: string, w: Window, notes: string[]): RawItem | 'skip' | 'outside' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    pushNote(notes, `${label}: オブジェクトではないためスキップしました`);
    return 'skip';
  }
  const record = value as Record<string, unknown>;
  if (record.source !== 'x') {
    const shown = typeof record.source === 'string' ? record.source : JSON.stringify(record.source);
    pushNote(notes, `${label}: 未対応の source (${shown}) のためスキップしました`);
    return 'skip';
  }
  if (typeof record.url !== 'string' || !isHttpUrl(record.url.trim())) {
    pushNote(notes, `${label}: url が http(s) ではないためスキップしました`);
    return 'skip';
  }
  const url = cleanUrl(record.url.trim());
  if (!/\/status\/\d+$/.test(new URL(url).pathname)) {
    pushNote(notes, `${label}: X のステータス URL ではないためスキップしました`);
    return 'skip';
  }

  const author = parseAuthor(record.author);
  if (!author) {
    pushNote(notes, `${label}: author（handle または name）が無い、または handle が不正なためスキップしました`);
    return 'skip';
  }
  if (typeof record.text !== 'string' || !record.text.trim()) {
    pushNote(notes, `${label}: text が空のためスキップしました`);
    return 'skip';
  }
  const published = parsePublishedAt(record.publishedAt);
  if (!published) {
    pushNote(notes, `${label}: publishedAt がタイムゾーン付きの ISO 8601 ではないためスキップしました`);
    return 'skip';
  }
  const at = published.getTime();
  if (at < w.start.getTime() || at >= w.end.getTime()) return 'outside';

  const metrics = parseMetrics(record.metrics, label, notes);
  if (!metrics) return 'skip';
  const links = parseLinks(record.links, label, notes);
  if (!links) return 'skip';

  let text = record.text.replace(/\r\n/g, '\n').trim();
  if (text.length > 20_000) {
    text = text.slice(0, 20_000);
    pushNote(notes, `${label}: text が長いため 20000 字で切り詰めました`);
  }

  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim())
    : [];

  return {
    id: hashId('x', normalizeUrl(url)),
    source: 'x',
    sourceLabel: 'X',
    title: postTitle(author.label, text),
    url,
    publishedAt: published.toISOString(),
    author: author.author,
    authorDetail: author.detail,
    tags,
    snippet: truncate(text.replace(/\s+/g, ' ').trim(), 400),
    body: text,
    metrics,
    lang: detectLang(`${author.label} ${text}`),
    sourceWeight: 3,
    ...(links.length > 0 ? { linkedUrls: links } : {}),
  };
}

export async function collectInbox(w: Window, dir = INBOX_DIR): Promise<IngestResult> {
  const notes: string[] = [];
  const items: RawItem[] = [];
  let outside = 0;
  let files = 0;

  for (const date of inboxFileDates(w)) {
    if (!DATE_FILE.test(`${date}.json`)) continue;
    let parsed: unknown[] | null;
    try {
      parsed = await readItems(date, dir, notes);
    } catch (err) {
      pushNote(notes, `${fileLabel(date)}: 読み込みに失敗したためスキップしました（${err instanceof Error ? err.message : err}）`);
      continue;
    }
    if (parsed == null) continue;
    files++;
    for (let i = 0; i < parsed.length; i++) {
      const label = `${fileLabel(date)} items[${i}]`;
      let item: RawItem | 'skip' | 'outside';
      try {
        item = parseItem(parsed[i], label, w, notes);
      } catch (err) {
        pushNote(notes, `${label}: 解釈に失敗したためスキップしました（${err instanceof Error ? err.message : err}）`);
        continue;
      }
      if (item === 'outside') {
        outside++;
        continue;
      }
      if (item === 'skip') continue;
      items.push(item);
    }
  }

  if (outside > 0) {
    log.info(`  inbox: ウィンドウ外 ${outside} 件を見送りました（別の日の実行が拾います）`);
  }
  if (files === 0) {
    log.info('  inbox: 対象ファイルはありません');
  }

  if (notes.length > NOTE_LIMIT) {
    const extra = notes.length - NOTE_LIMIT;
    notes.length = NOTE_LIMIT;
    notes.push(`ほか ${extra} 件の取り込みエラー`);
  }
  return { items, notes };
}
