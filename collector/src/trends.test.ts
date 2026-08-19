import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBoard,
  buildVocabulary,
  countDay,
  matchTopics,
  meaningfulVariant,
  mergeLedger,
  topicKey,
  trimLedger,
} from './trends.js';
import type { IndexEntry, RawItem, TrendDay } from './types.js';

/*
 * ここで固定したいのは、モックを実データで動かして分かった壊れ方の側。
 *
 *   - 部分文字列一致が単語境界を無視して `RCE` が "source" に当たる
 *   - 表記ゆれ（Qwen / Qwen3.8-27B）が別の話題として数えられ、どれも本数不足で消える
 *   - `Claude Code` が `Claude` に畳まれて別製品の話が 1 つの山になる
 *   - 常在語（毎日出る Claude Code）が「動いている話題」として出る
 *   - 同じ日の記事が 3 本並んで、話題がどこまで来たのか見えなくなる
 *
 * どれも「動くけれど無意味な出力」になる種類なので、実装が変わっても保ちたい。
 */

function item(over: Partial<RawItem> & { id: string }): RawItem {
  return {
    source: 'qiita',
    sourceLabel: 'Qiita',
    title: `記事 ${over.id}`,
    url: `https://example.com/${over.id}`,
    publishedAt: '2026-08-19T00:00:00.000Z',
    tags: [],
    snippet: '',
    metrics: {},
    lang: 'ja',
    sourceWeight: 1,
    ...over,
  };
}

function entry(over: Partial<IndexEntry> & { id: string; date: string }): IndexEntry {
  return {
    rank: null,
    title: `記事 ${over.id}`,
    titleJa: null,
    url: `https://example.com/${over.id}`,
    source: 'qiita',
    sourceLabel: 'Qiita',
    summary: '',
    keywords: [],
    topics: [],
    category: 'その他',
    lane: null,
    score: 0,
    publishedAt: `${over.date}T00:00:00.000Z`,
    lang: 'ja',
    ...over,
  };
}

/** 語彙は「2 回以上出た語」だけなので、テストでは同じ語を 2 回渡す */
function vocabOf(...terms: string[]) {
  return buildVocabulary([...terms, ...terms], []);
}

function day(date: string, pool: number, counts: Record<string, number>): TrendDay {
  return { date, pool, counts };
}

describe('topicKey', () => {
  it('区切り記号と複数形の違いを吸収する', () => {
    assert.equal(topicKey('TanStack/router'), topicKey('TanStack Router'));
    assert.equal(topicKey('AI agent'), topicKey('AI agents'));
    assert.equal(topicKey('Next.js'), topicKey('nextjs'));
  });

  it('別の製品は別のキーになる', () => {
    assert.notEqual(topicKey('Claude'), topicKey('Claude Code'));
  });
});

describe('matchTopics', () => {
  it('ASCII 語は単語境界を要求する（RCE が source に当たらない）', () => {
    const vocab = vocabOf('RCE');
    assert.equal(matchTopics('open source project', vocab).size, 0);
    assert.equal(matchTopics('RCE の実証', vocab).size, 1);
  });

  it('長い一致に含まれる短い一致は落とす', () => {
    const vocab = vocabOf('DeepSeek Harness', 'Harness');
    const hit = matchTopics('DeepSeek Harness を試した', vocab);
    assert.equal(hit.size, 1);
    assert.ok(hit.has(topicKey('DeepSeek Harness')));
  });

  it('日本語は単語境界が無いので部分一致で拾う', () => {
    const vocab = vocabOf('脆弱性');
    assert.equal(matchTopics('深刻な脆弱性が見つかった', vocab).size, 1);
  });

  it('カテゴリ語は語彙に入れない', () => {
    const vocab = vocabOf('AI', 'エージェント', 'セキュリティ');
    assert.equal(vocab.labels.size, 0);
  });

  it('掲載 1 回の新顔も語彙に入れる（拾いたいものの中心なので切らない）', () => {
    const vocab = buildVocabulary(['Cursor Origin'], []);
    assert.ok(vocab.labels.has(topicKey('Cursor Origin')));
  });

  it('タグは語彙にしない（実測で「システム」「tech」に埋まった）', () => {
    const vocab = buildVocabulary([], [
      item({ id: 'a', tags: ['システム', 'tech'] }),
      item({ id: 'b', tags: ['システム', 'tech'] }),
    ]);
    assert.equal(vocab.labels.size, 0);
  });
});

describe('buildVocabulary のファミリ束ね', () => {
  it('版名だけ違う表記は 1 つの話題にまとめる', () => {
    const vocab = vocabOf('Qwen', 'Qwen3.6', 'Qwen3.8-27B');
    const keys = new Set([
      ...matchTopics('Qwen3.8-27B が出た', vocab),
      ...matchTopics('Qwen3.6 を試す', vocab),
      ...matchTopics('Qwen の話', vocab),
    ]);
    assert.equal(keys.size, 1, [...keys].join(','));
    assert.ok(keys.has(topicKey('Qwen')));
  });

  it('独立した存在感を持つ子は親に畳まない', () => {
    // Claude Code は単独で 5 回以上出ている＝別の製品として扱う
    const vocab = buildVocabulary(
      ['Claude', 'Claude', 'Claude Code', 'Claude Code', 'Claude Code', 'Claude Code', 'Claude Code'],
      [],
    );
    const code = matchTopics('Claude Code の使い方', vocab);
    assert.ok(code.has(topicKey('Claude Code')), [...code].join(','));
    assert.ok(!code.has(topicKey('Claude')));
  });
});

describe('countDay', () => {
  it('話題ごとの本数と母集団を数える', () => {
    const vocab = vocabOf('Cursor');
    const counted = countDay('2026-08-19', [
      item({ id: 'a', title: 'Cursor Origin を触った' }),
      item({ id: 'b', title: 'Cursor の課金' }),
      item({ id: 'c', title: '無関係な記事' }),
    ], vocab);
    assert.equal(counted.day.pool, 3);
    assert.equal(counted.day.counts[topicKey('Cursor')], 2);
  });

  it('GitHub の owner/repo は語彙にする（構造化されているので信用できる）', () => {
    const vocab = buildVocabulary([], [
      item({ id: 'a', source: 'github_repo', title: 'honojs/hono — web framework' }),
    ]);
    assert.ok(vocab.labels.has(topicKey('honojs/hono')));
    // リポジトリ名だけは足さない（router / servers のような一般語になる）
    assert.ok(!vocab.labels.has(topicKey('hono')));
  });
});

describe('mergeLedger / trimLedger', () => {
  it('同じ日を二重に持たず、保持期間で切る', () => {
    const past = Array.from({ length: 30 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, 10, { a: 1 }),
    );
    const merged = mergeLedger(past, day('2026-07-30', 10, { a: 5 }));
    assert.equal(merged.length, 28);
    assert.equal(merged[merged.length - 1]!.date, '2026-07-30');
    assert.equal(merged[merged.length - 1]!.counts.a, 5);
  });

  it('出現 1 回だけの話題は台帳から落とす', () => {
    const days = trimLedger([day('2026-08-18', 10, { keep: 2, drop: 1 })]);
    assert.deepEqual(Object.keys(days[0]!.counts), ['keep']);
  });
});

describe('buildBoard', () => {
  const labels = new Map([
    ['cursor', 'Cursor'],
    ['python', 'Python'],
    ['ranosamuwea', 'ランサムウェア'],
  ]);
  const empty = new Map<string, IndexEntry[]>();

  function board(days: TrendDay[], date: string, over: Partial<Parameters<typeof buildBoard>[0]> = {}) {
    return buildBoard({
      date,
      updatedAt: `${date}T07:00:00.000Z`,
      days,
      labels,
      variantsByTopic: new Map(),
      publishedByTopic: empty,
      unplacedByTopic: new Map(),
      ...over,
    });
  }

  /**
   * 20 日ぶんの台帳。Python は毎日 20 本（背景）、Cursor は毎日 2 本で今日だけ 12 本。
   * 母集団 600 件は実測に合わせている。
   */
  function ledger(): TrendDay[] {
    return Array.from({ length: 20 }, (_, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
      return day(date, 600, { python: 20, cursor: date === '2026-08-20' ? 12 : 2 });
    });
  }

  it('毎日出ている語は背景に回り、動いている話題には入らない', () => {
    const b = board(ledger(), '2026-08-20');
    assert.ok(!b.hot.some((t) => t.key === 'python'));
    assert.ok(!b.keep.some((t) => t.key === 'python'));
    assert.ok(b.ubiquitous.includes('Python'));
  });

  it('平常より跳ねた話題を「今日動いた」に入れる', () => {
    const b = board(ledger(), '2026-08-20', {
      variantsByTopic: new Map([['cursor', new Set(['Cursor Origin'])]]),
    });
    const cursor = b.hot.find((t) => t.key === 'cursor');
    assert.ok(cursor, '跳ねた話題が hot に無い');
    assert.ok(cursor.lift != null && cursor.lift >= 1.8);
    assert.deepEqual(cursor.variants, ['Cursor Origin']);
  });

  it('母集団が増えただけの日を急上昇と誤らない', () => {
    // 件数は 3 倍だが母集団も 3 倍なので、水準は変わっていない
    const days = [
      ...Array.from({ length: 14 }, (_, i) =>
        day(`2026-08-${String(i + 1).padStart(2, '0')}`, 200, { cursor: 4 }),
      ),
      day('2026-08-15', 600, { cursor: 12 }),
    ];
    assert.ok(!board(days, '2026-08-15').hot.some((t) => t.key === 'cursor'));
  });

  it('出現日数ではなく水準で「追跡中」を決める（毎日出るだけでは入らない）', () => {
    /*
     * python は毎日 3 本で水準が動かない。cursor は直近 5 日だけ水準が 2 倍。
     * cursor の当日は 2 本（HOT_MIN_TODAY 未満）なので hot には入らない
     * ——hot は当日の跳ね、keep は続いている水準で、担当が別。
     */
    const days = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
      return day(date, 600, { python: 3, cursor: i >= 15 ? 2 : 1 });
    });
    const b = board(days, '2026-08-20');
    assert.ok(b.keep.some((t) => t.key === 'cursor'), '水準が上がった話題が keep に無い');
    assert.ok(!b.keep.some((t) => t.key === 'python'), '毎日出ているだけの語が keep に入った');
  });

  it('勢いが落ちた話題を「落ち着いた」に入れる（0 本になるのを待たない）', () => {
    const days = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
      // 7〜4 日前は 5 本、直近 3 日は 1 本。母集団が大きいので 0 にはならない
      const n = i >= 17 ? 1 : i >= 10 ? 5 : 0;
      return day(date, 600, n > 0 ? { ranosamuwea: n } : {});
    });
    assert.ok(board(days, '2026-08-20').cool.some((t) => t.key === 'ranosamuwea'));
  });

  it('立ち上げ中は平常比を出さず、そう書く', () => {
    const b = board(
      [day('2026-08-01', 600, { cursor: 4 }), day('2026-08-02', 600, { cursor: 5 })],
      '2026-08-02',
    );
    assert.equal(b.keep.length, 0);
    assert.equal(b.cool.length, 0);
    assert.equal(b.notes.length, 1);
    assert.ok(b.notes[0]!.includes('集計を始めたばかり'));
  });

  it('タイムラインは 1 日 1 件を代表にして、掲載順位つきを優先する', () => {
    const published = new Map<string, IndexEntry[]>([
      [
        'cursor',
        [
          entry({ id: 'today-other', date: '2026-08-20', lane: 'talk' }),
          entry({ id: 'today-top', date: '2026-08-20', lane: 'know', rank: 1 }),
          entry({ id: 'yesterday', date: '2026-08-19', lane: 'know', rank: 1 }),
          entry({ id: 'older', date: '2026-08-15', lane: 'build' }),
        ],
      ],
    ]);
    const cursor = board(ledger(), '2026-08-20', { publishedByTopic: published }).hot.find(
      (t) => t.key === 'cursor',
    );
    assert.ok(cursor);
    // 先頭 3 件は日付が全部違う（同じ日を 3 本並べない）
    assert.deepEqual(
      cursor.articles.slice(0, 3).map((a) => a.date),
      ['2026-08-20', '2026-08-19', '2026-08-15'],
    );
    // その日の代表は順位つきのほう
    assert.equal(cursor.articles[0]!.rank, 1);
    // 畳んだぶんも残っている
    assert.equal(cursor.articles.length, 4);
  });

  it('日別本数が同じ話題は畳む（略称は接頭辞では束ねられない）', () => {
    /*
     * DSH は DeepSeek Harness の略称。同じ記事群に当たっているので日別本数は
     * 完全に一致する。畳まないと同じタイムラインのカードが 2 枚並ぶ。
     */
    const withAlias = new Map([...labels, ['dsh', 'DSH'], ['deepseekharnes', 'DeepSeek Harness']]);
    const days = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
      const n = i >= 15 ? 2 : 0;
      return day(date, 600, n > 0 ? { dsh: n, deepseekharnes: n } : {});
    });
    const b = buildBoard({
      date: '2026-08-20',
      updatedAt: '2026-08-20T07:00:00.000Z',
      days,
      labels: withAlias,
      variantsByTopic: new Map(),
      publishedByTopic: empty,
      unplacedByTopic: new Map(),
    });
    const all = [...b.hot, ...b.keep, ...b.cool];
    const dsh = all.filter((t) => t.key === 'dsh' || t.key === 'deepseekharnes');
    assert.equal(dsh.length, 1, `2 枚残った: ${dsh.map((t) => t.name).join(',')}`);
    // 残すのは読んで分かる長い名前の側。畳んだ側は変種として出す
    assert.equal(dsh[0]!.name, 'DeepSeek Harness');
    assert.ok(dsh[0]!.variants.includes('DSH'));
  });

  it('出現日が少ない話題は偶然の一致で畳まない', () => {
    const withAlias = new Map([...labels, ['aaa', 'AAA'], ['bbb', 'BBB']]);
    const days = Array.from({ length: 20 }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, '0')}`, 600, i >= 18 ? { aaa: 2, bbb: 2 } : {}),
    );
    const b = buildBoard({
      date: '2026-08-20',
      updatedAt: '2026-08-20T07:00:00.000Z',
      days,
      labels: withAlias,
      variantsByTopic: new Map(),
      publishedByTopic: empty,
      unplacedByTopic: new Map(),
    });
    const all = [...b.hot, ...b.keep, ...b.cool].map((t) => t.key);
    assert.ok(all.includes('aaa') && all.includes('bbb'), all.join(','));
  });

  it('日本語の見出しをタイムラインへ通す（英語の題だけが混ざると読むのが止まる）', () => {
    const published = new Map<string, IndexEntry[]>([
      [
        'cursor',
        [
          entry({
            id: 'en',
            date: '2026-08-20',
            title: 'owner/repo — An English description',
            titleJa: '英語の記事に付けた日本語の見出し',
          }),
        ],
      ],
    ]);
    const cursor = board(ledger(), '2026-08-20', { publishedByTopic: published }).hot.find(
      (t) => t.key === 'cursor',
    );
    assert.equal(cursor?.articles[0]?.titleJa, '英語の記事に付けた日本語の見出し');
    // 原題は残す（画面では hover で読めるようにしている）
    assert.equal(cursor?.articles[0]?.title, 'owner/repo — An English description');
  });

  it('未掲載の記事は placement=none で混ぜる（掲載済みと区別できる）', () => {
    const b = board(ledger(), '2026-08-20', {
      unplacedByTopic: new Map([['cursor', [item({ id: 'pool', title: '未掲載の記事' })]]]),
    });
    const cursor = b.hot.find((t) => t.key === 'cursor');
    assert.ok(cursor);
    assert.ok(cursor.articles.some((a) => a.placement === 'none'));
  });
});

describe('meaningfulVariant', () => {
  it('数字・記号だけの差は変種として出さない', () => {
    assert.equal(meaningfulVariant('CVE-2026-60137', 'CVE'), false);
    assert.equal(meaningfulVariant('Next.js 16.3', 'Next.js'), false);
  });

  it('語が足されている表記は残す', () => {
    assert.equal(meaningfulVariant('Cursor Origin', 'Cursor'), true);
    assert.equal(meaningfulVariant('Gemini 3.7 Flash', 'Gemini'), true);
  });
});
