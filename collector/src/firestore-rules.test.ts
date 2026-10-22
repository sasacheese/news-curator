import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './config.js';
import { diffRules, matchBlocks } from './firestore-rules.js';

const wrap = (body: string) =>
  `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`;

describe('firestore.rules の比較', () => {
  it('documents 直下の match ブロックだけを取り出す（関数の中の波括弧で崩れない）', () => {
    const blocks = matchBlocks(
      wrap(`match /a/{id} { allow read: if f(); function f() { return true; } }
            // コメントの { は数えない
            match /b/{id} { allow write: if false; }`),
    );
    assert.deepEqual([...blocks.keys()], ['/a/{id}', '/b/{id}']);
  });

  it('現行にだけあるブロックは削除として出す（公開すると消えるので止める判断に使う）', () => {
    const current = wrap('match /a/{id} { allow read: if false; }\nmatch /legacy/{id} { allow read: if true; }');
    const next = wrap('match /a/{id} {  allow read:  if false; }\nmatch /c/{id} { allow read: if false; }');
    assert.deepEqual(diffRules(current, next), {
      unchanged: ['/a/{id}'],
      changed: [],
      added: ['/c/{id}'],
      removed: ['/legacy/{id}'],
    });
  });

  it('リポジトリの firestore.rules に 4 つのコレクションが揃っていて、読み取りは閉じている', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'firestore.rules'), 'utf8');
    const blocks = matchBlocks(source);
    assert.deepEqual(
      [...blocks.keys()].sort(),
      ['/feedback/{articleId}', '/pushSubscriptions/{subId}', '/toolInbox/{id}', '/toolState/{toolId}'],
    );
    for (const [path, body] of blocks) {
      assert.match(body, /allow read, list[^;]*: if false;/, `${path} の読み取りが閉じていない`);
    }
  });
});
