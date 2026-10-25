import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadRuntimeConfig, loadTopics } from './config.js';
import { enrichTopItems } from './enrich.js';
import { collectInbox, inboxFileDates, postTitle } from './inbox.js';
import { selectLaneCandidates } from './lanes.js';
import { dedupe, preScore } from './prescore.js';
import { LANES } from './types.js';
import { resolveWindow } from './util.js';

/*
 * 取り込みファイルはダイジェスト日の朝、07:00 より前に置かれる。
 * ウィンドウは [前日 07:00, 当日 07:00) JST。06:30 の投稿は当日分に一度だけ入り、
 * 翌日の実行が同じファイルを開いても、もう一度は入らない。
 */

const day = resolveWindow(new Date('2026-08-02T12:00:00Z'), '2026-08-02');
const next = resolveWindow(new Date('2026-08-03T12:00:00Z'), '2026-08-03');

function post(over: Record<string, unknown> = {}) {
  return {
    source: 'x',
    url: 'https://twitter.com/sasa/status/555?s=20&t=abc',
    author: { handle: 'sasa', name: 'ささ' },
    // 2026-08-02 06:30 JST。当日ウィンドウの終端（07:00）より前。
    publishedAt: '2026-08-02T06:30:00+09:00',
    text: 'Claude Code の本番権限をこう分けている。\n脆弱性のある MCP は通さない。',
    metrics: { likes: 20, reposts: 4, replies: 3, quotes: 1, bookmarks: 2, impressions: 9000 },
    links: ['https://example.com/writeup'],
    ...over,
  };
}

describe('inboxFileDates', () => {
  it('ダイジェスト日と、ウィンドウが始まる暦日を開く', () => {
    assert.deepEqual(inboxFileDates(day), ['2026-08-02', '2026-08-01']);
  });
});

describe('postTitle', () => {
  it('作者と最初の非空行を見出しにする', () => {
    assert.equal(postTitle('@sasa', '\n\n一行目です\n二行目'), '@sasa: 一行目です');
  });

  it('長い一行は切る', () => {
    const title = postTitle('@sasa', 'あ'.repeat(120));
    assert.ok(title.startsWith('@sasa: '));
    assert.ok(title.endsWith('…'));
    assert.ok(title.length < 100);
  });
});

describe('collectInbox', () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
    dirs.push(dir);
    return dir;
  }

  it('ファイルが無くても落ちない', async () => {
    const dir = await tempDir();
    const got = await collectInbox(day, dir);
    assert.deepEqual(got.items, []);
    assert.deepEqual(got.notes, []);
  });

  it('壊れた JSON は警告してスキップする', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '2026-08-02.json'), '{', 'utf8');
    const got = await collectInbox(day, dir);
    assert.deepEqual(got.items, []);
    assert.equal(got.notes.length, 1);
    assert.match(got.notes[0] ?? '', /JSON/);
  });

  it('不正な項目だけを落として、隣の投稿は残す', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, '2026-08-02.json'),
      JSON.stringify({
        items: [
          { source: 'x' },
          post(),
          { source: 'bluesky', url: 'https://bsky.app/profile/a/post/1', text: '後で足す', author: 'a', publishedAt: '2026-08-01T21:00:00Z' },
        ],
      }),
      'utf8',
    );
    const got = await collectInbox(day, dir);
    assert.equal(got.items.length, 1);
    assert.equal(got.items[0]?.url, 'https://x.com/sasa/status/555');
    assert.equal(got.items[0]?.source, 'x');
    assert.equal(got.items[0]?.author, 'ささ');
    assert.equal(got.items[0]?.authorDetail?.handle, '@sasa');
    assert.match(got.items[0]?.title ?? '', /^@sasa: Claude Code/);
    assert.match(got.items[0]?.body ?? '', /脆弱性のある MCP/);
    assert.equal(got.items[0]?.metrics.reposts, 4);
    assert.equal(got.items[0]?.metrics.comments, 3);
    assert.deepEqual(got.items[0]?.linkedUrls, ['https://example.com/writeup']);
    assert.ok(got.notes.length >= 2);
  });

  it('06:30 JST の投稿は当日に入り、翌日には入らない', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '2026-08-02.json'), JSON.stringify({ items: [post()] }), 'utf8');

    const today = await collectInbox(day, dir);
    assert.equal(today.items.length, 1);

    const tomorrow = await collectInbox(next, dir);
    assert.equal(tomorrow.items.length, 0);
    assert.deepEqual(tomorrow.notes, []);
  });

  it('07:00 ちょうどは当日の外で、翌日の先頭に一度だけ入る', async () => {
    const dir = await tempDir();
    // 2026-08-02 07:00 JST = 2026-08-01T22:00:00Z。当日ウィンドウの終端。
    const boundary = post({ publishedAt: '2026-08-02T07:00:00+09:00' });
    await writeFile(join(dir, '2026-08-02.json'), JSON.stringify({ items: [boundary] }), 'utf8');

    assert.equal((await collectInbox(day, dir)).items.length, 0);
    assert.equal((await collectInbox(next, dir)).items.length, 1);
  });

  it('前日のファイルに入ったウィンドウ内の投稿も、そのウィンドウで一度だけ拾う', async () => {
    const dir = await tempDir();
    // 2026-08-01 22:00 JST。8/1 のダイジェスト（〜07:00）には入らず、8/2 のウィンドウに入る。
    const evening = post({
      url: 'https://x.com/sasa/status/777',
      publishedAt: '2026-08-01T22:00:00+09:00',
      text: '夜に書いた。Terraform の本番構成の話。',
    });
    await writeFile(join(dir, '2026-08-01.json'), JSON.stringify({ items: [evening] }), 'utf8');

    const previousDay = resolveWindow(new Date('2026-08-01T12:00:00Z'), '2026-08-01');
    assert.equal((await collectInbox(previousDay, dir)).items.length, 0);
    assert.equal((await collectInbox(day, dir)).items.length, 1);
    assert.equal((await collectInbox(next, dir)).items.length, 0);
  });

  it('ホスト違いの同じ投稿は正規化 URL で 1 件になる', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, '2026-08-02.json'),
      JSON.stringify({
        items: [
          post({ url: 'https://mobile.twitter.com/Sasa/status/555?s=20' }),
          post({ url: 'https://x.com/sasa/status/555?t=zzz' }),
        ],
      }),
      'utf8',
    );
    const got = dedupe((await collectInbox(day, dir)).items, new Set());
    assert.equal(got.length, 1);
    assert.equal(got[0]?.url, 'https://x.com/sasa/status/555');
  });

  it('15 文字を超える handle はスキップする', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, '2026-08-02.json'),
      JSON.stringify({ items: [post({ author: { handle: 'news_curator_dry', name: '長い' } })] }),
      'utf8',
    );
    const got = await collectInbox(day, dir);
    assert.equal(got.items.length, 0);
    assert.match(got.notes[0] ?? '', /handle/);
  });

  it('タイムゾーンの無い時刻はスキップする', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, '2026-08-02.json'),
      JSON.stringify({ items: [post({ publishedAt: '2026-08-02T06:30:00' })] }),
      'utf8',
    );
    const got = await collectInbox(day, dir);
    assert.equal(got.items.length, 0);
    assert.match(got.notes[0] ?? '', /publishedAt/);
  });

  it('example.json は日付ファイルではないので読まない', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'example.json'), JSON.stringify({ items: [post()] }), 'utf8');
    const got = await collectInbox(day, dir);
    assert.equal(got.items.length, 0);
  });
});

describe('X 項目はダイジェストの項目まで流れる', () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('ルールベース採点の RankedItem になり、x.com は取得しない', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_BACKEND;

    const dir = await mkdtemp(join(tmpdir(), 'inbox-flow-'));
    dirs.push(dir);
    const text = 'Claude Code の本番権限をこう分けている。脆弱性のある MCP は通さない。';
    await writeFile(
      join(dir, '2026-08-02.json'),
      JSON.stringify({ items: [post({ text })] }),
      'utf8',
    );

    const { items, notes } = await collectInbox(day, dir);
    assert.deepEqual(notes, []);
    const scored = preScore(dedupe(items, new Set()), await loadTopics(), new Date('2026-08-02T12:00:00Z'));
    const runtime = loadRuntimeConfig();
    const selection = selectLaneCandidates(
      scored,
      runtime.laneCandidates,
      runtime.laneThresholds,
      runtime.securityPerLane,
    );
    const lanes = LANES.filter((lane) => selection.candidates[lane].some((item) => item.source === 'x'));
    assert.equal(lanes.length, 1);

    const { rankItems } = await import('./llm.js');
    const ranked = await rankItems(selection.candidates, await loadTopics(), runtime);
    const hit = ranked.find((item) => item.source === 'x');
    assert.ok(hit, 'X の投稿がランク結果に無い');
    assert.equal(hit.url, 'https://x.com/sasa/status/555');
    assert.match(hit.title, /^@sasa: Claude Code/);
    assert.equal(hit.body, text);
    assert.equal(hit.sourceLabel, 'X');
    assert.ok(hit.oneLiner.length > 0);
    assert.equal(hit.metrics.likes, 20);
    assert.equal(hit.metrics.reposts, 4);

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('<html><head></head><body><p>short</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };
    try {
      const enriched = await enrichTopItems([hit], 4_000);
      assert.match(enriched.items[0]?.body ?? '', /Claude Code/);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(
      calls.some((url) => /https?:\/\/([^/]+\.)?(x\.com|twitter\.com)/.test(url)),
      false,
      `x.com を取得した: ${calls.join(', ')}`,
    );
    assert.ok(
      calls.some((url) => url.includes('https://example.com/writeup')),
      'リンク先の記事を取りに行っていない',
    );
  });
});
