import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ARCHIVE_DAYS,
  type ToolCandidate,
  applyStateUpdates,
  archiveStale,
  buildToolBoard,
  emptyLedger,
  mergeCandidates,
  passPenalties,
  scoreTool,
  toolIdOf,
} from './tools.js';
import { classifyKind } from './tools-inspect.js';
import { showHnName } from './tools-intake.js';
import { isSafePublicUrl, linksFromOembedHtml } from './tools-inbox.js';
import { isCloudLaunch, marketplaceCandidate, mcpCandidate } from './tools-sources.js';

function cand(over: Partial<ToolCandidate> & { identity: ToolCandidate['identity'] }, date = '2026-10-10'): ToolCandidate {
  return {
    name: 'tool',
    homepage: 'https://example.com',
    signal: { source: 'gh-trending', date, strength: 0.6 },
    ...over,
  };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('mergeCandidates', () => {
  it('身元のどれかが一致すれば同じ道具として信号だけ足す', () => {
    const first = mergeCandidates(emptyLedger(), [cand({ identity: { github: 'Foo/Bar' } })], '2026-10-10');
    const second = mergeCandidates(
      first.ledger,
      [cand({ identity: { npm: 'bar', github: 'foo/bar' }, signal: { source: 'release', date: '2026-10-11', strength: 0.5 } })],
      '2026-10-11',
    );
    assert.equal(Object.keys(second.ledger.tools).length, 1);
    assert.equal(second.added.length, 0);
    const t = second.ledger.tools['gh:foo/bar']!;
    assert.equal(t.signals.length, 2);
    assert.equal(t.lastSignal, '2026-10-11');
    // 後から分かった身元は足される
    assert.equal(t.identity.npm, 'bar');
  });

  it('同じ入口・同じ日の信号は二重に数えない', () => {
    const a = mergeCandidates(emptyLedger(), [cand({ identity: { npm: 'x' } }), cand({ identity: { npm: 'x' } })], '2026-10-10');
    assert.equal(a.ledger.tools['npm:x']!.signals.length, 1);
    assert.deepEqual(a.ids, ['npm:x', 'npm:x']);
  });

  it('退避した道具に今日の信号が来たら再浮上し、見送った道具は戻さない', () => {
    let ledger = mergeCandidates(
      emptyLedger(),
      [cand({ identity: { npm: 'a' } }), cand({ identity: { npm: 'b' } })],
      '2026-10-01',
    ).ledger;
    ledger = archiveStale(ledger, addDays('2026-10-01', ARCHIVE_DAYS)).ledger;
    ledger = applyStateUpdates(ledger, [{ id: 'npm:b', state: 'passed', reason: 'out-of-scope', at: '2026-10-09T00:00:00Z' }]);
    const today = '2026-10-12';
    const r = mergeCandidates(
      ledger,
      [cand({ identity: { npm: 'a' } }, today), cand({ identity: { npm: 'b' } }, today)],
      today,
    );
    assert.deepEqual(r.resurfaced, ['npm:a']);
    assert.equal(r.ledger.tools['npm:a']!.state, 'new');
    assert.equal(r.ledger.tools['npm:b']!.state, 'passed');
  });
});

describe('archiveStale', () => {
  it(`新着のまま ${ARCHIVE_DAYS} 日たったものだけ退避する`, () => {
    let ledger = mergeCandidates(emptyLedger(), [cand({ identity: { npm: 'old' } })], '2026-10-01').ledger;
    ledger = mergeCandidates(ledger, [cand({ identity: { npm: 'fresh' } }, '2026-10-05')], '2026-10-05').ledger;
    ledger = mergeCandidates(ledger, [cand({ identity: { npm: 'kept' } })], '2026-10-01').ledger;
    ledger = applyStateUpdates(ledger, [{ id: 'npm:kept', state: 'interested', at: '2026-10-02T00:00:00Z' }]);
    const r = archiveStale(ledger, addDays('2026-10-01', ARCHIVE_DAYS));
    assert.deepEqual(r.archived, ['npm:old']);
    assert.equal(r.ledger.tools['npm:kept']!.state, 'interested');
  });
});

describe('applyStateUpdates', () => {
  it('見送りの理由を残し、知らない理由は other にする', () => {
    let ledger = mergeCandidates(emptyLedger(), [cand({ identity: { npm: 'x' } })], '2026-10-01').ledger;
    ledger = applyStateUpdates(ledger, [
      { id: 'npm:x', state: 'passed', reason: 'nonsense' as never, at: '2026-10-02T00:00:00Z' },
    ]);
    assert.equal(ledger.tools['npm:x']!.passReason, 'other');
  });

  it('台帳に無い ID と archived への書き込みは無視する', () => {
    const ledger = mergeCandidates(emptyLedger(), [cand({ identity: { npm: 'x' } })], '2026-10-01').ledger;
    const next = applyStateUpdates(ledger, [
      { id: 'npm:nope', state: 'tried', at: '2026-10-02T00:00:00Z' },
      { id: 'npm:x', state: 'archived', at: '2026-10-02T00:00:00Z' },
    ]);
    assert.equal(next.tools['npm:x']!.state, 'new');
    assert.equal(next.tools['npm:nope'], undefined);
  });
});

describe('点数と盤面', () => {
  it('最近・何度も見かけたものが上に来る', () => {
    let ledger = mergeCandidates(emptyLedger(), [cand({ identity: { npm: 'old' } })], '2026-10-01').ledger;
    ledger = mergeCandidates(
      ledger,
      [
        cand({ identity: { npm: 'hot' } }, '2026-10-06'),
        cand({ identity: { npm: 'hot' }, signal: { source: 'show-hn', date: '2026-10-06', strength: 0.7 } }, '2026-10-06'),
      ],
      '2026-10-06',
    ).ledger;
    const p = passPenalties(ledger, '2026-10-06');
    assert.ok(scoreTool(ledger.tools['npm:hot']!, '2026-10-06', p) > scoreTool(ledger.tools['npm:old']!, '2026-10-06', p));
  });

  it('「同等品を使っている」で見送った道具と同じものを置き換える道具は点数が半分になる', () => {
    let ledger = mergeCandidates(
      emptyLedger(),
      [cand({ identity: { npm: 'a' } }), cand({ identity: { npm: 'b' } })],
      '2026-10-01',
    ).ledger;
    ledger.tools['npm:a']!.replaces = 'Jest';
    ledger.tools['npm:b']!.replaces = 'jest';
    const before = scoreTool(ledger.tools['npm:b']!, '2026-10-01', passPenalties(ledger, '2026-10-01'));
    ledger = applyStateUpdates(ledger, [
      { id: 'npm:a', state: 'passed', reason: 'have-equivalent', at: '2026-10-01T00:00:00Z' },
    ]);
    const after = scoreTool(ledger.tools['npm:b']!, '2026-10-01', passPenalties(ledger, '2026-10-01'));
    assert.equal(after, Math.round(before * 0.5 * 1000) / 1000);
  });

  it('盤面は新着・キュー・触ったに分かれ、退避と見送りは出ない', () => {
    let ledger = mergeCandidates(
      emptyLedger(),
      ['n', 'i', 't', 'p'].map((x) => cand({ identity: { npm: x } })),
      '2026-10-01',
    ).ledger;
    ledger = applyStateUpdates(ledger, [
      { id: 'npm:i', state: 'interested', at: '2026-10-01T00:00:00Z' },
      { id: 'npm:t', state: 'tried', at: '2026-10-01T00:00:00Z' },
      { id: 'npm:p', state: 'passed', at: '2026-10-01T00:00:00Z' },
    ]);
    const board = buildToolBoard(ledger, '2026-10-01', {
      addedToday: 4,
      resurfacedToday: 0,
      notes: [],
      tryPromptOf: () => null,
    });
    assert.deepEqual(board.items.map((i) => i.id), ['npm:n']);
    assert.deepEqual(board.queue.map((i) => i.id), ['npm:i']);
    assert.deepEqual(board.tried.map((i) => i.id), ['npm:t']);
    assert.equal(board.stats.passed, 1);
  });

  it('ID は GitHub を優先する', () => {
    assert.equal(toolIdOf({ npm: 'x', github: 'O/R' }), 'gh:o/r');
    assert.equal(toolIdOf({ url: 'https://www.example.com/a/' }), toolIdOf({ url: 'https://example.com/a' }));
  });
});

describe('classifyKind', () => {
  it('専用ファイルがあれば Plugin / Skill に決まる', () => {
    assert.equal(classifyKind({ rootFiles: ['.claude-plugin', 'README.md'] }), 'plugin');
    assert.equal(classifyKind({ rootFiles: ['SKILL.md'] }), 'skill');
  });
  it('コードのリポジトリが同梱している .claude-plugin ではプラグインにしない', () => {
    assert.notEqual(
      classifyKind({ rootFiles: ['.claude-plugin', 'package.json'], description: 'React library for AI apps' }),
      'plugin',
    );
  });
  it('MCP は topic・キーワード・名前で決まる', () => {
    assert.equal(classifyKind({ topics: ['mcp-server'] }), 'mcp');
    assert.equal(classifyKind({ name: 'github-mcp' }), 'mcp');
    assert.equal(classifyKind({ npmKeywords: ['modelcontextprotocol'], npmHasBin: true }), 'mcp');
  });
  it('npm の bin があれば CLI、無ければライブラリ', () => {
    assert.equal(classifyKind({ npmHasBin: true }), 'cli');
    assert.equal(classifyKind({ npmHasBin: false }), 'library');
  });
  it('証拠が無ければ other', () => {
    assert.equal(classifyKind({ name: 'something', description: 'a thing' }), 'other');
  });
});

describe('入口', () => {
  it('Show HN の見出しから道具名を取る', () => {
    assert.equal(showHnName('Show HN: Foo – a fast bar'), 'Foo');
    assert.equal(showHnName('Show HN: Baz, the qux'), 'Baz');
    assert.equal(showHnName('Ask HN: what?'), null);
  });

  it('クラウドは新製品と GA だけを残す', () => {
    assert.ok(isCloudLaunch('Amazon Foo is now generally available'));
    assert.ok(isCloudLaunch('Introducing Cloudflare Bar'));
    assert.ok(!isCloudLaunch('Amazon Foo now available in additional regions'));
    assert.ok(!isCloudLaunch('Amazon Foo adds support for bar'));
  });

  it('MCP Registry は npm パッケージと GitHub を身元にし、秘密の環境変数があれば API キーを要るものに入れる', () => {
    const c = mcpCandidate(
      {
        server: {
          name: 'io.x/y',
          title: 'Y',
          repository: { url: 'https://github.com/x/y' },
          packages: [{ registryType: 'npm', identifier: '@x/y', environmentVariables: [{ isRequired: true, isSecret: true }] }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { publishedAt: '2026-10-10T01:00:00Z', isLatest: true, status: 'active' } },
      },
      { date: '2026-10-10', windowStart: new Date('2026-10-09T22:00:00Z') },
    );
    assert.deepEqual(c?.identity, { github: 'x/y', npm: '@x/y' });
    assert.equal(c?.kindHint, 'mcp');
    assert.deepEqual(c?.requires, ['API キー']);
  });

  it('MCP Registry の古い版・前回より前の公開は落とす', () => {
    const base = { server: { name: 'a', websiteUrl: 'https://a.example' } };
    const ctx = { date: '2026-10-10', windowStart: new Date('2026-10-09T22:00:00Z') };
    assert.equal(
      mcpCandidate({ ...base, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } } }, ctx),
      null,
    );
    assert.equal(
      mcpCandidate({ ...base, _meta: { 'io.modelcontextprotocol.registry/official': { publishedAt: '2026-01-01T00:00:00Z' } } }, ctx),
      null,
    );
  });

  it('マーケットプレイスの git-subdir はプラグインの置き場所を身元にする（同じリポジトリの別プラグインを潰さない）', () => {
    const a = marketplaceCandidate(
      { name: 'a', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'plugins/a' } },
      '2026-10-10',
      'https://m',
    );
    const b = marketplaceCandidate(
      { name: 'b', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'plugins/b' } },
      '2026-10-10',
      'https://m',
    );
    assert.notEqual(toolIdOf(a!.identity), toolIdOf(b!.identity));
    assert.equal(a!.kindHint, 'plugin');
  });

  it('貼られた URL は https の公開ホストだけ取りに行く', () => {
    assert.ok(isSafePublicUrl('https://github.com/o/r'));
    assert.ok(!isSafePublicUrl('http://github.com/o/r'));
    assert.ok(!isSafePublicUrl('https://localhost:3000'));
    assert.ok(!isSafePublicUrl('https://169.254.169.254/latest'));
    assert.ok(!isSafePublicUrl('not a url'));
  });

  it('X の oEmbed からは投稿本文のリンクだけを抜く', () => {
    const html =
      '<blockquote><p>new tool <a href="https://t.co/abc">t.co/abc</a> <a href="https://twitter.com/hashtag/x?src=hash">#x</a></p>' +
      '&mdash; Someone <a href="https://twitter.com/someone/status/1?ref_src=a&amp;b=c">Oct 1, 2026</a></blockquote>';
    assert.deepEqual(linksFromOembedHtml(html), ['https://t.co/abc']);
  });
});
