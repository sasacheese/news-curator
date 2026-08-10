import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toSchemaName } from './backend.js';

/*
 * ここで守りたいのは「表示用の stage 名を API の制約に合わせない」という設計。
 *
 * stage にコロンを入れた日に、OpenAI が response_format.json_schema.name を
 * ^[a-zA-Z0-9_-]+$ で弾き、採点・要約・深掘りの 3 段が丸ごと 400 で失敗した。
 * リクエスト単位で例外を握りつぶす作りなので画面には「採点失敗」としか出ず、
 * 実行ログを見るまで原因が分からなかった。stage の付け方を制約で縛るのではなく、
 * 境界で必ず落とすことをテストで固定する。
 */
describe('toSchemaName', () => {
  it('レーン付きの stage 名（コロン区切り）を通す形に落とす', () => {
    assert.equal(toSchemaName('score:know'), 'score_know');
    assert.equal(toSchemaName('describe:talk'), 'describe_talk');
    assert.equal(toSchemaName('deep:build'), 'deep_build');
  });

  it('スラッシュも落とす', () => {
    // check:llm のケース名は deep/know のようにスラッシュを使う
    assert.equal(toSchemaName('check:deep/know'), 'check_deep_know');
  });

  it('もともと通る名前は変えない', () => {
    for (const s of ['release', 'digest-summary', 'digest_outlook', 'score']) {
      assert.equal(toSchemaName(s), s);
    }
  });

  it('どんな stage 名でも API の制約を満たす', () => {
    const pattern = /^[a-zA-Z0-9_-]+$/;
    for (const s of ['日本語', 'a b', 'a.b', '', '::', 'score:know', 'deep/talk']) {
      assert.match(toSchemaName(s), pattern, `stage=${JSON.stringify(s)} が通らない`);
    }
  });

  it('記号だけの stage 名でも空にしない', () => {
    // 空文字は name として不正なので、必ず何か残す
    assert.equal(toSchemaName('::'), '__');
    assert.equal(toSchemaName(''), 'schema');
  });
});
