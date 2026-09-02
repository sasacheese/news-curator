import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRY_PROMPT_HEADINGS,
  TRY_PROMPT_MAX,
  buildTryPrompt,
  identityFromUrl,
  sanitizeTryPrompt,
} from './try-prompt.js';

/*
 * ここで固定したいのは 2 つ。
 *
 * ひとつは「記事に箱を出さない」こと。Qiita や Zenn の URL から身元が取れてしまうと、
 * 記事を clone する手順が並ぶ。
 *
 * もうひとつは「道具は取りこぼさない」こと。この枠（発掘・リリース・その他候補）は
 * LLM の判定を通さないのが取り柄なので、URL の形が少し違うだけで null になると
 * 静かに機能が死ぬ。実データに出てくる形を並べてある。
 */
describe('identityFromUrl', () => {
  it('GitHub のリポジトリ直リンクから owner/repo を取る', () => {
    assert.deepEqual(identityFromUrl('https://github.com/TanStack/table'), {
      githubRepo: 'TanStack/table',
      tag: null,
    });
  });

  it('リリースの URL からはタグも取る（その版を固定して clone するため）', () => {
    assert.deepEqual(identityFromUrl('https://github.com/vitejs/vite/releases/tag/v8.2.0'), {
      githubRepo: 'vitejs/vite',
      tag: 'v8.2.0',
    });
  });

  it('リポジトリ配下の別のパスでも owner/repo は取れる', () => {
    const id = identityFromUrl('https://github.com/facebook/react/blob/main/README.md');
    assert.equal(id?.githubRepo, 'facebook/react');
    assert.equal(id?.tag, null);
  });

  it('npm のパッケージ URL（スコープ付きを含む）を取る', () => {
    assert.deepEqual(identityFromUrl('https://www.npmjs.com/package/@tanstack/react-table'), {
      npmPackage: '@tanstack/react-table',
    });
  });

  it('記事の URL からは何も取らない', () => {
    for (const url of [
      'https://qiita.com/foo/items/abc123',
      'https://zenn.dev/foo/articles/bar',
      'https://news.ycombinator.com/item?id=1',
      'https://b.hatena.ne.jp/entry/s/example.com',
      'https://vercel.com/changelog/something',
    ]) {
      assert.equal(identityFromUrl(url), null, url);
    }
  });

  it('空・未定義でも落ちない', () => {
    assert.equal(identityFromUrl(''), null);
    assert.equal(identityFromUrl(null), null);
    assert.equal(identityFromUrl(undefined), null);
  });
});

/*
 * 形が崩れたプロンプトは出さない。見出しが欠けたり順番が違ったりしたものが
 * カードに出ると、読者はどこを読めばいいか分からず、貼った先のエージェントも
 * 目標と手順を取り違える。長さの上限はディープリンクの都合（README 参照）。
 */
describe('sanitizeTryPrompt', () => {
  const ok = [
    '# 試すこと',
    'foo を入れて最初の出力を見る',
    'https://github.com/o/foo',
    '',
    '# 手順',
    '1. npm i -g foo',
    '',
    '# 確認したいこと',
    '- 入るか',
    '',
    '# 前提・注意',
    '- 特になし',
  ].join('\n');

  it('4 節がこの順で揃っていれば通す（前後の空白は落とす）', () => {
    assert.equal(sanitizeTryPrompt(`\n${ok}\n\n`), ok);
  });

  it('CRLF は LF に揃える', () => {
    assert.equal(sanitizeTryPrompt(ok.replace(/\n/g, '\r\n')), ok);
  });

  it('見出しが 1 つでも欠けたら落とす', () => {
    for (const heading of TRY_PROMPT_HEADINGS) {
      assert.equal(sanitizeTryPrompt(ok.replace(heading, heading.slice(2))), null, heading);
    }
  });

  it('見出しの順番が違えば落とす', () => {
    const swapped = ok.replace('# 手順', '# 確認したいこと__').replace(/^# 確認したいこと$/m, '# 手順');
    assert.equal(sanitizeTryPrompt(swapped.replace('# 確認したいこと__', '# 確認したいこと')), null);
  });

  it('上限を超えたら落とす', () => {
    assert.equal(sanitizeTryPrompt(ok + '\n' + 'あ'.repeat(TRY_PROMPT_MAX)), null);
  });

  it('空・null・undefined は null', () => {
    assert.equal(sanitizeTryPrompt(''), null);
    assert.equal(sanitizeTryPrompt('   '), null);
    assert.equal(sanitizeTryPrompt(null), null);
    assert.equal(sanitizeTryPrompt(undefined), null);
  });
});

describe('buildTryPrompt', () => {
  const input = { goal: 'foo を入れて動かす', url: 'https://example.com/foo', questions: ['入るか'] };

  it('npm があれば版まで固定して入れ、4 節の形で返す', () => {
    const p = buildTryPrompt({ npmPackage: 'foo', npmVersion: '1.2.3' }, input);
    assert.ok(p);
    assert.match(p, /^# 試すこと\nfoo を入れて動かす\nhttps:\/\/example\.com\/foo\n/);
    assert.match(p, /1\. npm i -g foo@1\.2\.3/);
    assert.match(p, /npm ls/);
    assert.match(p, /# 確認したいこと\n- 入るか/);
    assert.equal(sanitizeTryPrompt(p), p);
  });

  it('版が分からなければパッケージ名だけで入れる', () => {
    const p = buildTryPrompt({ npmPackage: 'foo' }, input);
    assert.match(p!, /npm i -g foo \|\|/);
  });

  it('npm と GitHub の両方があるときは npm を選ぶ（版が固定できる）', () => {
    const p = buildTryPrompt({ npmPackage: 'foo', npmVersion: '1.0.0', githubRepo: 'o/r' }, input);
    assert.match(p!, /npm i/);
    assert.doesNotMatch(p!, /git clone/);
  });

  it('GitHub だけなら clone し、タグがあれば固定する', () => {
    const p = buildTryPrompt({ githubRepo: 'o/r', tag: 'v2.0.0' }, input);
    assert.match(p!, /git clone --depth 1 --branch v2\.0\.0 https:\/\/github\.com\/o\/r/);
    assert.match(p!, /cd r && ls/);
  });

  it('身元が無い・問いが無いなら null', () => {
    assert.equal(buildTryPrompt(null, input), null);
    assert.equal(buildTryPrompt({}, input), null);
    assert.equal(buildTryPrompt({ githubRepo: 'o/r' }, { ...input, questions: [] }), null);
    assert.equal(buildTryPrompt({ githubRepo: 'o/r' }, { ...input, questions: ['  '] }), null);
  });
});
