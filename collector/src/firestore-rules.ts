import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REPO_ROOT } from './config.js';

/**
 * firestore.rules をコンソールの現行ルールと比べ、必要なら公開する。
 *
 *   npm run -w collector rules:check   … 比べるだけ（公開しない）
 *   npm run -w collector rules:apply   … 比べてから公開する
 *
 * GitHub Actions（.github/workflows/firestore-rules.yml）から呼ぶ前提。
 * リポジトリは公開でログも誰でも読めるので、**ルールの本文はログに出さない。**
 * 出すのは match ブロックの名前と「変更なし / 変更あり / 追加 / 削除」だけ。
 *
 * 公開すると現行ルールは丸ごと置き換わる。現行にだけあるブロック（コンソールで
 * 直接足したもの）は消えてしまうので、その場合は公開せずに失敗させる。
 */

/** documents 直下の match ブロックを「パス → 本文」で取り出す。比較用なので空白は詰める */
export function matchBlocks(source: string): Map<string, string> {
  const text = source.replace(/\/\/[^\n]*/g, '');
  const root = /match\s+\/databases\/\{database\}\/documents\s*\{/.exec(text);
  const blocks = new Map<string, string>();
  if (!root) return blocks;

  let i = root.index + root[0].length;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (depth === 1) {
      const m = /^\s*match\s+(\/(?:[^\s{]|\{[^}]*\})+)\s*\{/.exec(text.slice(i));
      if (m) {
        const start = i;
        i += m[0].length;
        let d = 1;
        while (i < text.length && d > 0) {
          if (text[i] === '{') d++;
          else if (text[i] === '}') d--;
          i++;
        }
        blocks.set(m[1]!, text.slice(start, i).replace(/\s+/g, ' ').trim());
        continue;
      }
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return blocks;
}

export interface RulesDiff {
  unchanged: string[];
  changed: string[];
  added: string[];
  /** 現行にだけあるブロック。公開すると消える */
  removed: string[];
}

export function diffRules(current: string, next: string): RulesDiff {
  const a = matchBlocks(current);
  const b = matchBlocks(next);
  const diff: RulesDiff = { unchanged: [], changed: [], added: [], removed: [] };
  for (const [path, body] of b) {
    if (!a.has(path)) diff.added.push(path);
    else if (a.get(path) === body) diff.unchanged.push(path);
    else diff.changed.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) diff.removed.push(path);
  return diff;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON が未設定です。');

  const [{ cert, getApps, initializeApp }, { getSecurityRules }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/security-rules'),
  ]);
  const app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(json)) });
  const rules = getSecurityRules(app);

  const next = await readFile(resolve(REPO_ROOT, 'firestore.rules'), 'utf8');
  const current = await rules.getFirestoreRuleset().then(
    (r) => r.source.map((f) => f.content).join('\n'),
    (err: unknown) => {
      // 一度も公開していないプロジェクトでは現行ルールが無い
      if (err && typeof err === 'object' && 'code' in err && String(err.code).includes('not-found')) return '';
      throw err;
    },
  );

  const diff = diffRules(current, next);
  const line = (label: string, paths: string[]) => console.log(`${label}: ${paths.length ? paths.join(', ') : '（なし）'}`);
  line('変更なし', diff.unchanged);
  line('変更あり', diff.changed);
  line('追加', diff.added);
  line('削除（現行にだけある）', diff.removed);

  if (diff.removed.length > 0) {
    throw new Error(
      '現行ルールにだけあるブロックがあります。公開すると消えるので、先に firestore.rules へ取り込んでください。',
    );
  }
  if (diff.changed.length === 0 && diff.added.length === 0 && current.trim()) {
    console.log('差分が無いので公開しません。');
    return;
  }
  if (!apply) {
    console.log('確認だけのモードなので公開しません。');
    return;
  }
  // 構文はサーバー側で検証される。誤りがあればここで例外になり、現行ルールはそのまま残る
  const released = await rules.releaseFirestoreRulesetFromSource(next);
  console.log(`公開しました（ruleset: ${released.name.split('/').pop()}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
