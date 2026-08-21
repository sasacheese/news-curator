import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrialPlan, identityFromUrl } from './trial-plan.js';

/*
 * ここで固定したいのは 2 つ。
 *
 * ひとつは「記事にボタンを出さない」こと。Qiita や Zenn の URL から身元が取れて
 * しまうと、記事を clone しようとして必ず失敗するレポートが並ぶ。
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
    assert.deepEqual(
      identityFromUrl('https://github.com/vitejs/vite/releases/tag/v8.2.0'),
      { githubRepo: 'vitejs/vite', tag: 'v8.2.0' },
    );
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

describe('buildTrialPlan', () => {
  const Q = ['入るか'];

  it('npm があれば版まで固定して入れる', () => {
    const plan = buildTrialPlan({ npmPackage: 'foo', npmVersion: '1.2.3' }, Q);
    assert.equal(plan?.runner, 'node');
    assert.match(plan!.install, /foo@1\.2\.3/);
    assert.match(plan!.verify, /npm ls/);
  });

  it('版が分からなければパッケージ名だけで入れる', () => {
    const plan = buildTrialPlan({ npmPackage: 'foo' }, Q);
    assert.match(plan!.install, /npm i .*foo(?!@)/);
  });

  it('npm と GitHub の両方があるときは npm を選ぶ（版が固定できる）', () => {
    const plan = buildTrialPlan({ npmPackage: 'foo', npmVersion: '1.0.0', githubRepo: 'o/r' }, Q);
    assert.match(plan!.install, /npm i/);
  });

  it('GitHub だけなら clone する。タグがあれば固定する', () => {
    const plain = buildTrialPlan({ githubRepo: 'o/r' }, Q);
    assert.equal(plain?.runner, 'shell');
    assert.equal(plain?.install, 'git clone --depth 1 https://github.com/o/r');
    assert.equal(plain?.verify, 'ls r');

    const tagged = buildTrialPlan({ githubRepo: 'o/r', tag: 'v2' }, Q);
    assert.match(tagged!.install, /--branch v2/);
  });

  it('身元が無ければ null（ボタンを出さない）', () => {
    assert.equal(buildTrialPlan(null, Q), null);
    assert.equal(buildTrialPlan({}, Q), null);
    assert.equal(buildTrialPlan({ npmPackage: '  ', githubRepo: '' }, Q), null);
  });

  it('問いが無ければ null（動作確認だけでは読者に残らない）', () => {
    assert.equal(buildTrialPlan({ githubRepo: 'o/r' }, []), null);
  });
});
