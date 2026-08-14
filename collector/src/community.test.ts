import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompleteOptions, CompleteResult, LlmBackend } from './backend.js';
import type { CommunityConfig, RawEvent } from './community.js';
import {
  buildBoard,
  daysUntil,
  detectVenue,
  isReachable,
  judgeSpeakItems,
  matchTopics,
  pickAction,
  pickScale,
} from './community.js';
import { loadRuntimeConfig } from './config.js';
import type { CommunitySpeakResult } from './schemas.js';
import type { TopicsConfig } from './types.js';

/*
 * 絞り込みはここが本体で、全部ルールベース。実在のイベント名で固定する。
 *
 * いちばん壊れやすいのは「距離を規模で緩める」ところ。緩めすぎると行けない
 * もくもく会で埋まり、締めすぎると TSKaigi や ISUCON が構造的に落ちる。
 */

const NOW = new Date('2026-08-13T00:00:00+09:00');

const CFG: CommunityConfig = {
  enabled: true,
  location: { prefectures: ['東京都'], online: true },
  horizonDays: 21,
  cfpHorizonDays: 45,
  keywords: ['React', 'TypeScript', 'もくもく'],
  exclude: ['転職', '経営', '講座'],
  excludeOrganizers: ['majisemi'],
  cfpTopics: ['javascript'],
  limits: { speak: 6, attend: 8, work: 4 },
};

const TOPICS: TopicsConfig = {
  profile: 'フロントエンド寄りのフルスタックエンジニア',
  topics: [
    { name: 'React', weight: 5, keywords: ['react', 'リアクト'] },
    { name: 'TypeScript', weight: 5, keywords: ['typescript'] },
  ],
  exclude: { keywords: [] },
};

function event(partial: Partial<RawEvent> & { title: string; url: string }): RawEvent {
  return {
    source: 'connpass',
    sourceLabel: 'connpass',
    description: '',
    organizer: null,
    startsAt: new Date('2026-08-20T19:00:00+09:00'),
    endsAt: null,
    place: null,
    address: null,
    limit: null,
    accepted: null,
    waiting: null,
    cfpEndsAt: null,
    country: '日本',
    onlineFlag: false,
    ...partial,
  };
}

describe('pickAction', () => {
  it('募集していることが語で確定しているものを speak にする', () => {
    assert.equal(pickAction(event({ title: 'TSKaigi 2026 登壇者募集', url: 'https://a/1' })), 'speak');
    assert.equal(
      pickAction(event({ title: 'React 勉強会 #12', url: 'https://a/2', description: 'LT枠あります' })),
      'speak',
    );
    assert.equal(
      pickAction(event({ title: 'Frontend Conf', url: 'https://a/3', description: 'Call for Proposals 受付中' })),
      'speak',
    );
  });

  it('LT を聞くだけの回は speak にしない', () => {
    // 「LT」の語だけで拾うと、登壇できないものまで登壇枠に並ぶ
    assert.equal(pickAction(event({ title: 'LT大会の様子をふりかえる会', url: 'https://a/4' })), 'attend');
    assert.equal(
      pickAction(event({ title: 'React 勉強会', url: 'https://a/5', description: '過去のLT動画を見ます' })),
      'attend',
    );
  });

  it('もくもく会を work にする', () => {
    assert.equal(pickAction(event({ title: '朝もくもく会 #204', url: 'https://a/6' })), 'work');
    assert.equal(pickAction(event({ title: '土曜朝活・作業会', url: 'https://a/7' })), 'work');
  });

  it('どれでもないものは attend に落ちる', () => {
    assert.equal(pickAction(event({ title: 'React Tokyo Meetup', url: 'https://a/8' })), 'attend');
  });
});

describe('pickScale', () => {
  it('カンファレンス相当の語で conference にする', () => {
    for (const title of ['TSKaigi 2026', 'JSConf JP 2026', 'ISUCON15', '技術書典ハッカソン']) {
      assert.equal(pickScale(event({ title, url: 'https://a/x' })), 'conference', title);
    }
  });

  it('定員 200 以上と複数日開催も conference にする', () => {
    assert.equal(pickScale(event({ title: '大規模勉強会', url: 'https://a/9', limit: 300 })), 'conference');
    assert.equal(
      pickScale(
        event({
          title: '合宿型ワークショップ',
          url: 'https://a/10',
          startsAt: new Date('2026-08-20T10:00:00+09:00'),
          endsAt: new Date('2026-08-21T17:00:00+09:00'),
        }),
      ),
      'conference',
    );
  });

  it('連番が振られたものは recurring にする', () => {
    assert.equal(pickScale(event({ title: 'React もくもく会 #12', url: 'https://a/11' })), 'recurring');
    assert.equal(pickScale(event({ title: '第30回 フロントエンド勉強会', url: 'https://a/12' })), 'recurring');
  });

  it('単発の勉強会は meetup', () => {
    assert.equal(pickScale(event({ title: 'React Tokyo Meetup', url: 'https://a/13' })), 'meetup');
  });
});

describe('detectVenue', () => {
  it('住所から都道府県を引く', () => {
    const v = detectVenue(event({ title: 'x', url: 'https://a/14', address: '東京都千代田区大手町1-6-1' }));
    assert.equal(v.prefecture, '東京都');
    assert.equal(v.mode, 'onsite');
  });

  it('都道府県が省かれた政令市を補う', () => {
    // 実測で Doorkeeper に「神戸市中央区…」がそのまま入っていた
    const v = detectVenue(event({ title: 'x', url: 'https://a/15', address: '神戸市中央区元町通3-9-8' }));
    assert.equal(v.prefecture, '兵庫県');
  });

  it('オンラインの語を拾う', () => {
    const v = detectVenue(event({ title: '【オンライン】React 勉強会', url: 'https://a/16' }));
    assert.equal(v.mode, 'online');
  });

  it('現地とオンラインの両方があれば hybrid', () => {
    const v = detectVenue(
      event({ title: 'React 勉強会（現地+オンライン）', url: 'https://a/17', address: '東京都渋谷区' }),
    );
    assert.equal(v.mode, 'hybrid');
  });

  it('場所が書かれていないものは現地扱いにしない', () => {
    // 実測で Doorkeeper のウェビナーは place / address がどちらも空だった
    const v = detectVenue(event({ title: 'セミナー', url: 'https://a/18' }));
    assert.equal(v.mode, 'online');
  });
});

describe('isReachable', () => {
  const location = { prefectures: ['東京都'], online: true };
  const onsite = (prefecture: string | null, country = '日本') =>
    ({ mode: 'onsite' as const, place: null, prefecture, country });

  it('カンファレンスは距離を問わない', () => {
    // 近所だけにすると TSKaigi / ISUCON が構造的に落ちる
    assert.equal(isReachable('conference', onsite('京都府'), location), true);
    assert.equal(isReachable('conference', onsite('福岡県'), location), true);
  });

  it('カンファレンスでも海外の現地開催は落とす', () => {
    assert.equal(isReachable('conference', onsite(null, 'Singapore'), location), false);
  });

  it('勉強会・もくもく会は行ける範囲だけ', () => {
    assert.equal(isReachable('meetup', onsite('東京都'), location), true);
    assert.equal(isReachable('meetup', onsite('大阪府'), location), false);
    assert.equal(isReachable('recurring', onsite('神奈川県'), location), false);
  });

  it('オンラインは設定で切れる', () => {
    const online = { mode: 'online' as const, place: null, prefecture: null, country: '不明' };
    assert.equal(isReachable('meetup', online, location), true);
    assert.equal(isReachable('meetup', online, { prefectures: ['東京都'], online: false }), false);
  });
});

describe('matchTopics', () => {
  it('タイトルに当たったものだけを返す', () => {
    // 長い説明文にはスポンサー紹介や過去回の告知が続くので、本文一致は付けない
    const ev = event({ title: 'React 勉強会', url: 'https://a/19', description: 'TypeScript の話も' });
    assert.deepEqual(matchTopics(ev, TOPICS.topics), ['React']);
  });
});

describe('daysUntil', () => {
  it('JST の暦日で数える', () => {
    assert.equal(daysUntil(new Date('2026-08-13T23:00:00+09:00'), NOW), 0);
    assert.equal(daysUntil(new Date('2026-08-14T01:00:00+09:00'), NOW), 1);
    assert.equal(daysUntil(new Date('2026-08-12T23:00:00+09:00'), NOW), -1);
  });
});

describe('buildBoard', () => {
  const empty = new Set<string>();

  it('開催が先でも締切が近いものを拾う', () => {
    /*
     * この枠の存在理由。公開ウィンドウや開催日だけで切ると、
     * 「開催は 3 か月後だが締切は明日」の CFP が落ちる。
     */
    const items = buildBoard(
      [
        event({
          title: 'JSConf JP 2026 CFP',
          url: 'https://a/cfp',
          startsAt: new Date('2026-11-20T10:00:00+09:00'),
          cfpEndsAt: new Date('2026-08-15T23:59:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.action, 'speak');
    assert.equal(items[0]?.deadline?.daysLeft, 2);
  });

  it('締切は開催日より先まで見る', () => {
    // 登壇は準備期間が要るので、締切の 3 週間前に初めて見えるのでは遅い。
    // horizonDays（21）を超えて cfpHorizonDays（45）まで拾う
    const items = buildBoard(
      [
        event({
          title: 'VimConf 2026 CFP',
          url: 'https://a/cfp-far',
          startsAt: new Date('2026-12-01T10:00:00+09:00'),
          cfpEndsAt: new Date('2026-09-20T23:59:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.deadline?.daysLeft, 38);
  });

  it('締切が過ぎた登壇募集は開催が先でも出さない', () => {
    const items = buildBoard(
      [
        event({
          title: 'JSConf JP 2026 CFP',
          url: 'https://a/cfp2',
          startsAt: new Date('2026-11-20T10:00:00+09:00'),
          cfpEndsAt: new Date('2026-08-01T23:59:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 0);
  });

  it('attend にはトピック一致を要求し、speak と work には要求しない', () => {
    /*
     * 母集団がビジネスセミナーで埋まるので attend には門番が必要。
     * 一方 speak は「話せる題材があるか」で決まるので一致を要求すると狭まり、
     * もくもく会のタイトルに React は出てこないので work も要求できない。
     */
    const items = buildBoard(
      [
        event({ title: 'なにかの勉強会', url: 'https://a/20', address: '東京都渋谷区' }),
        event({ title: 'なにかの勉強会 登壇者募集', url: 'https://a/21', address: '東京都渋谷区' }),
        event({ title: 'もくもく会 #3', url: 'https://a/22', address: '東京都渋谷区' }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.deepEqual(
      items.map((i) => i.action),
      ['speak', 'work'],
    );
  });

  it('除外語をタイトルで落とす', () => {
    const items = buildBoard(
      [event({ title: 'React エンジニアの転職セミナー', url: 'https://a/23', address: '東京都' })],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 0);
  });

  it('連番を振らずに毎週開かれるものも主催で畳む', () => {
    // 実測で Doorkeeper の「Asana Refresh Morning（8月17日）」と「（8月24日）」が
    // 別のイベントとして 2 件並んだ。scale では捕まらない
    const items = buildBoard(
      [
        event({
          title: 'React Refresh Morning（8月24日）',
          url: 'https://a/r2',
          organizer: 'refresh',
          address: '東京都',
          startsAt: new Date('2026-08-24T09:00:00+09:00'),
        }),
        event({
          title: 'React Refresh Morning（8月17日）',
          url: 'https://a/r1',
          organizer: 'refresh',
          address: '東京都',
          startsAt: new Date('2026-08-17T09:00:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'React Refresh Morning（8月17日）');
  });

  it('主催そのものを落とす（ベンダーのウェビナー配信元）', () => {
    // サブドメインを分けて同じ内容を何本も出すので、主催の畳み込みをすり抜ける
    const items = buildBoard(
      [
        event({
          title: '生成AIで増えるコード、レビューはどう変わるべきか',
          url: 'https://a/v1',
          organizer: 'majisemi-operation',
        }),
        event({
          title: 'AI活用は企業データで決まる',
          url: 'https://a/v2',
          organizer: 'majisemi-data',
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 0);
  });

  it('同じ主催の定例回は直近の1件だけにする', () => {
    const items = buildBoard(
      [
        event({
          title: 'もくもく会 #10',
          url: 'https://a/24',
          organizer: 'tokyo-mokumoku',
          address: '東京都',
          startsAt: new Date('2026-08-15T10:00:00+09:00'),
        }),
        event({
          title: 'もくもく会 #11',
          url: 'https://a/25',
          organizer: 'tokyo-mokumoku',
          address: '東京都',
          startsAt: new Date('2026-08-22T10:00:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'もくもく会 #10');
  });

  it('締切の近い登壇募集を先に並べる', () => {
    const items = buildBoard(
      [
        event({
          title: 'Conf A 登壇者募集',
          url: 'https://a/26',
          cfpEndsAt: new Date('2026-08-25T23:59:00+09:00'),
        }),
        event({
          title: 'Conf B 登壇者募集',
          url: 'https://a/27',
          cfpEndsAt: new Date('2026-08-16T23:59:00+09:00'),
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      empty,
    );
    assert.deepEqual(
      items.map((i) => i.title),
      ['Conf B 登壇者募集', 'Conf A 登壇者募集'],
    );
  });

  it('前日に無かったものへ NEW を付ける', () => {
    const events = [
      event({ title: 'React Meetup', url: 'https://a/28', address: '東京都' }),
      event({ title: 'TypeScript Meetup', url: 'https://a/29', address: '東京都' }),
    ];
    const first = buildBoard(events, CFG, TOPICS, NOW, new Set());
    // 初日は全件 false。全部に NEW が付くと目印として死ぬ
    assert.deepEqual(first.map((i) => i.isNew), [false, false]);

    const second = buildBoard(events, CFG, TOPICS, NOW, new Set([first[0]!.id]));
    assert.deepEqual(second.map((i) => i.isNew), [false, true]);
  });

  it('同じイベントが2つのソースに出たら connpass を残す', () => {
    const items = buildBoard(
      [
        event({ title: 'React Meetup', url: 'https://connpass.com/event/1/', address: '東京都' }),
        event({
          title: 'React Meetup',
          url: 'https://connpass.com/event/1/',
          address: '東京都',
          source: 'doorkeeper',
          sourceLabel: 'Doorkeeper',
        }),
      ],
      CFG,
      TOPICS,
      NOW,
      new Set(),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sourceLabel, 'connpass');
  });

  it('行動ごとの上限を守る', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      event({ title: `もくもく会 ${i}`, url: `https://a/w${i}`, address: '東京都' }),
    );
    const items = buildBoard(many, CFG, TOPICS, NOW, new Set());
    assert.equal(items.length, CFG.limits.work);
  });
});

/*
 * 「登壇できる」だけは LLM を通す。ここで守りたいのは
 * **募集していないものを募集中として並べないこと**。この枠で一番まずい壊れ方なので、
 * 判定できない場合は枠ごと落とす方に倒す。
 */

function fakeBackend(result: CommunitySpeakResult): LlmBackend {
  return {
    name: 'fake',
    metered: false,
    async complete<T>(_opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
      return {
        value: result as unknown as T,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      };
    },
  };
}

describe('judgeSpeakItems', () => {
  const runtime = loadRuntimeConfig();
  const board = () =>
    buildBoard(
      [
        event({
          title: 'TSKaigi 2026 登壇者募集',
          url: 'https://a/s1',
          description: 'LT 5分 × 6枠を募集しています',
          cfpEndsAt: new Date('2026-08-20T23:59:00+09:00'),
        }),
        event({ title: 'React もくもく会 #3', url: 'https://a/s2', address: '東京都' }),
      ],
      CFG,
      TOPICS,
      NOW,
      new Set(),
    );

  it('LLM が無い日は登壇枠ごと落とす（参加系は残す）', () => {
    const items = judgeSpeakItems(board(), new Map(), null, TOPICS, runtime, NOW);
    return items.then((out) => {
      assert.deepEqual(out.map((i) => i.action), ['work']);
    });
  });

  it('募集が終わっているものを落とす', async () => {
    const b = board();
    const out = await judgeSpeakItems(
      b,
      new Map(),
      fakeBackend({
        items: [{ ref: 0, isOpen: false, callFor: null, deadlineAt: null, angles: [] }],
      }),
      TOPICS,
      runtime,
      NOW,
    );
    assert.deepEqual(out.map((i) => i.action), ['work']);
  });

  it('募集中のものに募集内容と題材を入れる', async () => {
    const out = await judgeSpeakItems(
      board(),
      new Map(),
      fakeBackend({
        items: [
          {
            ref: 0,
            isOpen: true,
            callFor: 'LT 5分 × 6枠',
            deadlineAt: '2026-08-18',
            angles: ['型パズルの実務での落とし所', 'AI エージェント併用時のレビュー負荷の実測'],
          },
        ],
      }),
      TOPICS,
      runtime,
      NOW,
    );
    const speak = out.find((i) => i.action === 'speak');
    assert.equal(speak?.callFor, 'LT 5分 × 6枠');
    // LLM が読んだ締切で差し替える（confs.tech 由来の 8/20 より正確）
    assert.equal(speak?.deadline?.daysLeft, 5);
    assert.equal(speak?.angles.length, 2);
  });

  it('文で返ってきた題材は落とす（発表の代筆になるため）', async () => {
    const out = await judgeSpeakItems(
      board(),
      new Map(),
      fakeBackend({
        items: [
          {
            ref: 0,
            isOpen: true,
            callFor: null,
            deadlineAt: null,
            angles: ['型パズルの落とし所', 'React はもっと使うべきだ', '型推論は難しいと思う。'],
          },
        ],
      }),
      TOPICS,
      runtime,
      NOW,
    );
    assert.deepEqual(out.find((i) => i.action === 'speak')?.angles, ['型パズルの落とし所']);
  });

  it('LLM が読んだ締切が過ぎていたら落とす', async () => {
    const out = await judgeSpeakItems(
      board(),
      new Map(),
      fakeBackend({
        items: [
          { ref: 0, isOpen: true, callFor: null, deadlineAt: '2026-08-01', angles: [] },
        ],
      }),
      TOPICS,
      runtime,
      NOW,
    );
    assert.deepEqual(out.map((i) => i.action), ['work']);
  });
});
