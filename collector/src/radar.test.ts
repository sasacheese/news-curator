import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RadarConfig } from './radar.js';
import {
  adoptionStrength,
  buildEvidence,
  candidatePriority,
  collectCandidates,
  dedupeByIdentity,
  domesticThickness,
  findHypeWords,
  isPlausibleToolName,
  judge,
  looksLikeWrongPackage,
  measureOrder,
  mergeCandidates,
  momentum,
  needsMeasure,
  pruneLedger,
  radarKey,
  resolveFirstStep,
  stripVersion,
  tagSlug,
} from './radar.js';
import type { IndexEntry, RadarLedgerEntry, RadarMeasure, RawItem } from './types.js';

/*
 * ここで固定したいのは判定の「落とす側」。
 *
 * この機能の値打ちは、紹介した相手に「それもう使ってますよ」と返されないこと
 * だけで担保されている。だから枠を埋めようとして基準が緩む方向の変更を、
 * テストで止められる形にしておく。実測値（2026-08 時点）をそのまま使っている
 * のは、しきい値を動かしたときに何が出て何が落ちるかが読めるようにするため。
 */

const CFG: RadarConfig = {
  enabled: true,
  domesticThin: 120,
  domesticKnown: 400,
  measureBudget: 24,
  remeasureAfterDays: 14,
  minMentions: 2,
  adoption: { npmWeekly: 30_000, stars: 1500 },
  limits: { early: 5, hidden: 5 },
  exclude: ['React', 'Claude Code'],
};

const NOW = new Date('2026-08-20T00:00:00.000Z');

function measure(over: Partial<RadarMeasure> = {}): RadarMeasure {
  return {
    githubRepo: 'owner/repo',
    githubStars: 5000,
    githubPushedAt: '2026-08-19T00:00:00.000Z',
    githubArchived: false,
    npmPackage: 'pkg',
    npmVersion: '1.0.0',
    npmDeprecated: false,
    npmWeekly: 500_000,
    npmTrend: 1.0,
    abroadMentions: 1,
    qiitaArticles: 40,
    qiitaMethod: 'mention',
    zennArticles: 30,
    zennMethod: 'topic',
    zennComplete: true,
    domesticMentions: 0,
    measuredAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

const judgeIt = (m: RadarMeasure, affinity = 0) => judge(m, CFG, { now: NOW, affinity });

describe('isPlausibleToolName', () => {
  it('道具の名前になりうる形を通す', () => {
    for (const n of ['Oxlint', 'TanStack Router', 'unplugin', 'uv', '@tanstack/react-router']) {
      assert.equal(isPlausibleToolName(n), true, n);
    }
  });

  it('設定ファイル名・バージョン・一般名詞を落とす', () => {
    // 実測でダイジェストの keywords に入っていたもの。計測は 1 語 4 リクエスト
    // かかるので、こういう語に予算を使わないことが直接コストに効く
    for (const n of [
      'CLAUDE.md',
      'settings.json',
      'v2.1.225',
      'CVE-2026-53609',
      'サブエージェント',
      'AIエージェント',
      'セキュリティ',
      'https://example.com',
      'a very long descriptive phrase here',
    ]) {
      assert.equal(isPlausibleToolName(n), false, n);
    }
  });
});

describe('radarKey / tagSlug', () => {
  it('表記揺れを 1 つのキーにまとめる', () => {
    assert.equal(radarKey('Oxlint'), radarKey('oxlint'));
    assert.equal(radarKey('TanStack  Router'), 'tanstack router');
  });

  it('スラッグはタグ・トピックの形にする', () => {
    assert.equal(tagSlug('TanStack Router'), 'tanstack-router');
    assert.equal(tagSlug('@tanstack/react-router'), 'tanstackreact-router');
  });
});

describe('domesticThickness', () => {
  it('両方揃って初めて合計を返す', () => {
    assert.equal(domesticThickness(measure({ qiitaArticles: 40, zennArticles: 31 })), 71);
    // 0 は実測。欠測と区別する
    assert.equal(domesticThickness(measure({ qiitaArticles: 0, zennArticles: 0 })), 0);
  });

  it('片方でも欠測なら null。取れたほうだけで代用しない', () => {
    /*
     * 実際に壊れた形: Qiita がレート上限で 403 を返した実行で、TanStack Table が
     * 「日本語の記事は 0 本」として盤面に載った（本当は 36 本）。
     * この数字でする主張は「まだ薄い」= 上限の主張なので、
     * 下限側に振れる数字では言えない。
     */
    assert.equal(domesticThickness(measure({ qiitaArticles: null, zennArticles: 10 })), null);
    assert.equal(domesticThickness(measure({ qiitaArticles: 26, zennArticles: null })), null);
    assert.equal(domesticThickness(measure({ qiitaArticles: null, zennArticles: null })), null);
  });
});

describe('judge', () => {
  it('国内が厚いものは既知として落とす', () => {
    // 実測: Hono は Qiita 890 + Zenn 1045 = 1935 本
    const j = judgeIt(measure({ qiitaArticles: 890, zennArticles: 1045 }));
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /既に知られている/);
  });

  it('中間帯（薄いとは言えない）も落とす', () => {
    // 実測: Biome は 506 本、Nitro は 499 本。どちらも紹介する段階を過ぎている
    assert.equal(judgeIt(measure({ qiitaArticles: 324, zennArticles: 182 })).verdict, null);
    // thin(120) と known(400) の間。枠を埋めたくなる帯だが出さない
    const middle = judgeIt(measure({ qiitaArticles: 150, zennArticles: 50 }));
    assert.equal(middle.verdict, null);
    assert.match(middle.reason ?? '', /薄い」とは言えない/);
  });

  it('国内の記事数が測れなければ判定しない。どちらが欠けたかを残す', () => {
    const j = judgeIt(measure({ qiitaArticles: null, zennArticles: 10 }));
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /測れなかった（Qiita）/);

    const both = judgeIt(measure({ qiitaArticles: null, zennArticles: null }));
    assert.match(both.reason ?? '', /Qiita \/ Zenn/);
  });

  it('Qiita が落ちた実行で、Zenn だけの数字を根拠に「薄い」と言わない', () => {
    // 実測で TanStack Table が「日本語の記事 0 本」として通ってしまった形
    const j = judgeIt(
      measure({ qiitaArticles: null, zennArticles: 0, npmWeekly: 16_820_000, githubStars: 28_348 }),
    );
    assert.equal(j.verdict, null);
  });

  it('アーカイブ済みのリポジトリは最初に落とす', () => {
    // 紹介した後で「それ開発終わってますよ」と返されるのが最悪の壊れ方
    const j = judgeIt(measure({ githubArchived: true, qiitaArticles: 2, zennArticles: 3 }));
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /アーカイブ/);
  });

  it('薄くても、使われている証拠も勢いも無ければ出さない', () => {
    const j = judgeIt(
      measure({
        qiitaArticles: 1,
        zennArticles: 0,
        npmWeekly: 200,
        githubStars: 40,
        npmTrend: 1.0,
        abroadMentions: 0,
        githubPushedAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /証拠/);
  });

  it('国内が薄く大量に使われているものは hidden', () => {
    // 実測: unplugin は npm 週 5,118 万 DL、GitHub 3,605★、国内 41 本。
    // スターは伸びていないのに使用量は桁違い——この枠の典型
    const j = judgeIt(
      measure({
        qiitaArticles: 33,
        zennArticles: 8,
        npmWeekly: 51_186_571,
        githubStars: 3605,
        npmTrend: 1.0,
        abroadMentions: 1,
        githubPushedAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    assert.equal(j.verdict, 'hidden');
    assert.ok(j.score > 40, `score=${j.score}`);
  });

  it('勢いがあるものは hidden ではなく early', () => {
    // 今まさに伸びているものを「知られてないけど便利」と紹介すると、
    // 相手が既に知っている確率が高い（そう遠くないうちに知られる）
    const j = judgeIt(
      measure({
        qiitaArticles: 15,
        zennArticles: 5,
        npmWeekly: 1_395_710,
        npmTrend: 1.6,
        abroadMentions: 4,
        githubPushedAt: '2026-08-19T00:00:00.000Z',
      }),
    );
    assert.equal(j.verdict, 'early');
  });

  it('関心の近さは順位を動かすが、判定は動かさない', () => {
    // 関心を門番にすると、既に知っている領域しか出てこなくなる
    const m = measure({ qiitaArticles: 10, zennArticles: 6, npmWeekly: 5_730_269 });
    const far = judgeIt(m, 0);
    const near = judgeIt(m, 1);
    assert.equal(far.verdict, near.verdict);
    assert.ok(near.score > far.score);
  });
});

describe('momentum / adoptionStrength', () => {
  it('週次のゆらぎ（1.15 倍まで）は勢いと数えない', () => {
    const flat = momentum(measure({ npmTrend: 1.1, abroadMentions: 0, githubPushedAt: null }), NOW);
    assert.equal(flat, 0);
  });

  it('スターが少なくても使用量が多ければ実力として認める', () => {
    const lowStars = measure({ githubStars: 200, npmWeekly: 20_000_000 });
    assert.ok(adoptionStrength(lowStars) > 0.9);
  });

  it('npm に無い道具はスターだけで測る', () => {
    const cliOnly = measure({ npmPackage: null, npmWeekly: null, githubStars: 20_000 });
    assert.equal(adoptionStrength(cliOnly), 1);
  });
});

describe('buildEvidence', () => {
  it('数字と数え方をそのまま出す', () => {
    const lines = buildEvidence(
      measure({ npmWeekly: 13_552_486, githubStars: 22_367, qiitaArticles: 44, zennArticles: 31 }),
      NOW,
    );
    assert.ok(lines.some((l) => l.includes('1,355 万')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('22,367')));
    assert.ok(lines.some((l) => l.includes('日本語の記事は 75 本')));
  });

  it('数え切れていない件数は下限値だと分かるように書く', () => {
    // 検索が 1 ページに収まらなかった場合、その件数は下限値でしかない
    const lines = buildEvidence(
      measure({ zennArticles: 48, zennMethod: 'search', zennComplete: false }),
      NOW,
    );
    assert.ok(lines.some((l) => l.includes('Zenn 48 本以上')), lines.join(' / '));
  });

  it('Qiita がタグ検索のときもそう書く', () => {
    const lines = buildEvidence(measure({ qiitaArticles: 31, qiitaMethod: 'tag' }), NOW);
    assert.ok(lines.some((l) => l.includes('Qiita のタグ 31 本')), lines.join(' / '));
  });
});

describe('collectCandidates', () => {
  const entry = (over: Partial<IndexEntry>): IndexEntry => ({
    id: 'x',
    date: '2026-08-18',
    rank: null,
    title: '記事',
    titleJa: null,
    url: 'https://example.com/a',
    source: 'qiita',
    sourceLabel: 'Qiita',
    summary: '',
    keywords: [],
    topics: [],
    category: 'その他',
    lane: 'build',
    score: 50,
    publishedAt: '2026-08-18T00:00:00.000Z',
    lang: 'ja',
    ...over,
  });

  it('言語ごとに出現回数を分けて数える', () => {
    const found = collectCandidates(
      [
        entry({ keywords: ['Oxlint'], lang: 'en' }),
        entry({ keywords: ['Oxlint'], lang: 'en', date: '2026-08-17' }),
        entry({ keywords: ['Oxlint'], lang: 'ja', date: '2026-08-16' }),
      ],
      [],
      CFG,
    );
    const oxlint = found.find((c) => radarKey(c.name) === 'oxlint');
    assert.ok(oxlint);
    assert.equal(oxlint.abroad, 2);
    assert.equal(oxlint.domestic, 1);
  });

  it('除外リストの語と出現回数の足りない語を落とす', () => {
    const found = collectCandidates(
      [
        entry({ keywords: ['React', 'Claude Code'], lang: 'en' }),
        entry({ keywords: ['React'], lang: 'en', date: '2026-08-17' }),
        entry({ keywords: ['OnlyOnce'], lang: 'en' }),
      ],
      [],
      CFG,
    );
    assert.deepEqual(found.map((c) => c.name), []);
  });

  it('当日の GitHub リポジトリは 1 回でも候補にする', () => {
    // 過去のインデックスは「掲載された記事」しか含まないので、まだ誰も
    // 記事にしていない道具はここからしか入ってこない
    const repo: RawItem = {
      id: 'r1',
      source: 'github_repo',
      sourceLabel: 'GitHub 急上昇リポジトリ',
      title: 'unjs/unplugin — Unified plugin system',
      url: 'https://github.com/unjs/unplugin',
      publishedAt: '2026-08-19T00:00:00.000Z',
      tags: [],
      snippet: '',
      metrics: { stars: 3605 },
      lang: 'en',
      sourceWeight: 1,
    };
    const found = collectCandidates([], [repo], CFG);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'unplugin');
    assert.equal(found[0]?.repoHint, 'unjs/unplugin');
  });

  it('英語圏で繰り返し見て日本語で見ないものを上に置く', () => {
    const a = { name: 'A', abroad: 5, domestic: 0, via: null, repoHint: null };
    const b = { name: 'B', abroad: 5, domestic: 4, via: null, repoHint: null };
    assert.ok(candidatePriority(a) > candidatePriority(b));
  });
});

describe('台帳', () => {
  const base: RadarLedgerEntry = {
    id: 'id1',
    name: 'Oxlint',
    resolved: {
      isTool: true,
      displayName: 'Oxlint',
      npmPackage: 'oxlint',
      githubRepo: 'oxc-project/oxc',
      what: 'Rust 製のリンタ',
      nameIsCommonWord: false,
      at: '2026-08-01T00:00:00.000Z',
    },
    measure: null,
    history: [],
    pitch: null,
    mentions: { abroad: 2, domestic: 0 },
    firstSeenAt: '2026-08-01',
    lastSeenAt: '2026-08-01',
    featuredAt: null,
    lastVerdict: null,
    lastReason: null,
  };

  it('既知の語は出現回数と最終確認日だけ更新し、解決結果と紹介文を残す', () => {
    // ここを作り直すと、盤面に載り続けているものの文面が毎日変わる
    const merged = mergeCandidates(
      [{ ...base, pitch: { pitch: 'p', insteadOf: [], firstStep: null, fitFor: [], caution: null, at: 'x' } }],
      [{ name: 'oxlint', abroad: 7, domestic: 1, via: null, repoHint: null }],
      '2026-08-20',
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.mentions.abroad, 7);
    assert.equal(merged[0]?.lastSeenAt, '2026-08-20');
    assert.equal(merged[0]?.resolved?.npmPackage, 'oxlint');
    assert.equal(merged[0]?.pitch?.pitch, 'p');
    assert.equal(merged[0]?.firstSeenAt, '2026-08-01');
  });

  it('道具でないと分かった語には計測しない', () => {
    const notTool = { ...base, resolved: { ...base.resolved!, isTool: false } };
    assert.equal(needsMeasure(notTool, CFG, NOW), false);
  });

  it('計測済みでも間隔を過ぎたら測り直す', () => {
    const fresh = { ...base, measure: measure({ measuredAt: '2026-08-18T00:00:00.000Z' }) };
    const stale = { ...base, measure: measure({ measuredAt: '2026-07-01T00:00:00.000Z' }) };
    assert.equal(needsMeasure(fresh, CFG, NOW), false);
    assert.equal(needsMeasure(stale, CFG, NOW), true);
  });

  it('判定に至らなかった計測は翌日に測り直す', () => {
    /*
     * Qiita がレート上限を返した 1 回の実行のせいで、その語が 14 日ずっと
     * 盤面に出てこなくなるのはおかしい
     */
    const failedToday = {
      ...base,
      measure: measure({ measuredAt: '2026-08-20T00:00:00.000Z', qiitaArticles: null }),
    };
    const failedYesterday = {
      ...base,
      measure: measure({ measuredAt: '2026-08-19T00:00:00.000Z', qiitaArticles: null }),
    };
    assert.equal(needsMeasure(failedToday, CFG, NOW), false);
    assert.equal(needsMeasure(failedYesterday, CFG, NOW), true);
  });

  it('まだ一度も測っていないものを先に測る', () => {
    // 永久に引けない語が毎日予算の先頭を占めると、新しい候補が測られない
    const virgin = { ...base, name: 'New', measure: null, mentions: { abroad: 1, domestic: 0 } };
    const failed = {
      ...base,
      name: 'Broken',
      measure: measure({ qiitaArticles: null }),
      mentions: { abroad: 9, domestic: 0 },
    };
    assert.deepEqual([failed, virgin].sort(measureOrder).map((e) => e.name), ['New', 'Broken']);
  });

  it('道具でなかった語だけを、見かけなくなってから落とす', () => {
    const old = { ...base, name: 'Old', resolved: { ...base.resolved!, isTool: false }, lastSeenAt: '2025-01-01' };
    const oldTool = { ...base, name: 'OldTool', lastSeenAt: '2025-01-01' };
    const kept = pruneLedger([old, oldTool], '2026-08-20');
    assert.deepEqual(kept.map((e) => e.name), ['OldTool']);
  });
});

describe('findHypeWords', () => {
  it('中身の無い評価語を検出する', () => {
    assert.deepEqual(findHypeWords('今めちゃくちゃ話題の爆速リンタです'), ['話題の', '爆速']);
    assert.deepEqual(findHypeWords('ESLint の設定のまま実行時間を詰められます'), []);
  });
});

describe('dedupeByIdentity', () => {
  const entry = (name: string, npm: string | null, mentions: number): RadarLedgerEntry => ({
    id: `id-${name}`,
    name,
    resolved: {
      isTool: true,
      displayName: name,
      npmPackage: npm,
      githubRepo: null,
      what: '',
      nameIsCommonWord: false,
      at: '2026-08-01T00:00:00.000Z',
    },
    measure: null,
    history: [],
    pitch: null,
    mentions: { abroad: mentions, domestic: 0 },
    firstSeenAt: '2026-08-01',
    lastSeenAt: '2026-08-01',
    featuredAt: null,
    lastVerdict: null,
    lastReason: null,
  });

  it('同じ npm パッケージに解決された語は、代表を 1 つに絞る', () => {
    // 実測で「TanStack Table」と「@tanstack/table-core」が別々に並んでいた。
    // どちらも計測値を持たないので、呼び名の多いほう（人が使う名前）が残る
    const kept = dedupeByIdentity([
      entry('TanStack Table', '@tanstack/table-core', 3),
      entry('@tanstack/table-core', '@tanstack/table-core', 1),
    ]);
    assert.deepEqual(kept.map((e) => e.name), ['TanStack Table']);
  });

  it('解決できていない語は名前で区別したまま残す', () => {
    const kept = dedupeByIdentity([entry('Foo', null, 2), entry('Bar', null, 1)]);
    assert.equal(kept.length, 2);
  });
});

describe('計測値を信用してよいかの判定', () => {
  it('npm で非推奨のものは出さない', () => {
    // 紹介した相手に「それ deprecated ですよ」と返されるのは、
    // アーカイブ済みのリポジトリを勧めるのと同じ壊れ方
    const j = judgeIt(measure({ npmDeprecated: true, qiitaArticles: 2, zennArticles: 3 }));
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /非推奨/);
  });

  it('国内の記事数を数え切れなかったものは「薄い」と言わない', () => {
    // 「まだ薄い」は上限の主張。Zenn の検索が 1 ページに収まらなかった場合、
    // 実際は 1,000 本あるかもしれないので、上から抑えられていない
    const j = judgeIt(
      measure({ qiitaArticles: 10, zennArticles: 48, zennMethod: 'search', zennComplete: false }),
    );
    assert.equal(j.verdict, null);
    assert.match(j.reason ?? '', /数え切れなかった/);
  });

  it('検索由来でも数え切れていれば実測として使う', () => {
    // 実測: 「TanStack Router」は検索 31 件で next_page なし = ちょうど 31 本
    const j = judgeIt(
      measure({
        qiitaArticles: 10,
        zennArticles: 31,
        zennMethod: 'search',
        zennComplete: true,
        npmWeekly: 20_000_000,
      }),
    );
    assert.equal(j.verdict !== null, true);
  });
});

describe('resolveFirstStep', () => {
  it('検証済みの npm パッケージがあれば機械で組み立てる', () => {
    // LLM が書いた `npm i @tanstack/table`（存在しない）を採用しない
    const m = measure({ npmPackage: '@tanstack/table-core' });
    assert.equal(resolveFirstStep(m, 'npm i @tanstack/table'), 'npm i @tanstack/table-core');
  });

  it('npm の外のコマンドは LLM の書いたものを使う', () => {
    const m = measure({ npmPackage: null });
    assert.equal(resolveFirstStep(m, 'brew install foo'), 'brew install foo');
    assert.equal(resolveFirstStep(m, 'cargo install foo'), 'cargo install foo');
    assert.equal(resolveFirstStep(m, null), null);
  });

  it('検証できていない npm のコマンドは捨てる', () => {
    // 検証済みの名前が無い = その道具について LLM の npm 知識が当てにならないと
    // 分かっている状況。打って失敗するコマンドを出すほうが損失が大きい
    const m = measure({ npmPackage: null });
    assert.equal(resolveFirstStep(m, 'npm i @tanstack/table-core'), null);
    assert.equal(resolveFirstStep(m, 'npx oxlint@latest .'), null);
    assert.equal(resolveFirstStep(m, 'pnpm add valibot'), null);
  });
});

describe('stripVersion', () => {
  it('末尾の裸のバージョンだけを落とす', () => {
    assert.equal(stripVersion('Next.js 16.3'), 'Next.js');
    assert.equal(stripVersion('Dify 1.x'), 'Dify');
    assert.equal(stripVersion('Vite 8'), 'Vite');
  });

  it('名前の一部として数字を持つものは触らない', () => {
    // モデル名は世代が名前の一部なので、落とすと別物になる
    assert.equal(stripVersion('Gemini 3.6 Flash'), 'Gemini 3.6 Flash');
    assert.equal(stripVersion('S3'), 'S3');
  });
});

describe('looksLikeWrongPackage', () => {
  it('スターの多い道具でダウンロードが下回っていたら取り違えを疑う', () => {
    // 実測: @tanstack/router は 14,964★ に対して週 5,390 DL。
    // 本体は @tanstack/react-router で、こちらは 0.0.1-beta.53 のまま止まっている
    assert.equal(looksLikeWrongPackage(5_390, 14_964), true);
  });

  it('実際に使われている道具は通す', () => {
    // スターが伸びていないのに使用量が桁違いなもの（この枠の本命）を誤検出しない
    assert.equal(looksLikeWrongPackage(51_186_571, 3_605), false);
    assert.equal(looksLikeWrongPackage(13_552_486, 22_367), false);
    assert.equal(looksLikeWrongPackage(1_747_603, 17_145), false);
  });

  it('まだ小さい道具では比が意味を持たないので判定しない', () => {
    assert.equal(looksLikeWrongPackage(80, 100), false);
  });

  it('どちらかが測れていなければ判定しない', () => {
    assert.equal(looksLikeWrongPackage(null, 20_000), false);
    assert.equal(looksLikeWrongPackage(100, null), false);
  });
});

describe('dedupeByIdentity の 2 段目', () => {
  const entry = (
    name: string,
    display: string,
    repo: string | null,
    npm: string | null,
    weekly: number | null,
  ): RadarLedgerEntry => ({
    id: `id-${name}`,
    name,
    resolved: {
      isTool: true,
      displayName: display,
      npmPackage: npm,
      githubRepo: repo,
      what: '',
      nameIsCommonWord: false,
      at: '2026-08-01T00:00:00.000Z',
    },
    measure: weekly == null ? null : measure({ npmWeekly: weekly }),
    history: [],
    pitch: null,
    mentions: { abroad: 3, domestic: 0 },
    firstSeenAt: '2026-08-01',
    lastSeenAt: '2026-08-01',
    featuredAt: null,
    lastVerdict: null,
    lastReason: null,
  });

  it('npm 名が食い違っていてもリポジトリが同じならまとめる', () => {
    // 実測: 片方の npm 名は 404 で捨てられ、リポジトリだけが一致していた
    const kept = dedupeByIdentity([
      entry('@tanstack/table-core', 'TanStack Table', 'TanStack/table', '@tanstack/table-core', 16_820_000),
      entry('TanStack Table', 'TanStack Table', 'TanStack/table', null, null),
    ]);
    assert.equal(kept.length, 1);
    // ダウンロード数を出せるほうを代表にする
    assert.equal(kept[0]?.name, '@tanstack/table-core');
  });

  it('識別子が違っても同じ表示名なら 1 枚にする', () => {
    const kept = dedupeByIdentity([
      entry('foo-a', 'Foo', 'a/foo', null, 100),
      entry('foo-b', 'Foo', 'b/foo', null, null),
    ]);
    assert.equal(kept.length, 1);
  });

  it('別の道具は分けたまま残す', () => {
    const kept = dedupeByIdentity([
      entry('TanStack Table', 'TanStack Table', 'TanStack/table', null, null),
      entry('TanStack Router', 'TanStack Router', 'TanStack/router', null, null),
    ]);
    assert.equal(kept.length, 2);
  });
});
