import type { z } from 'zod';
import { loadRuntimeConfig } from './config.js';
import { getBackend } from './llm.js';
import { complete } from './llm.js';
import {
  BuildDeepDiveSchema,
  CommunitySpeakResultSchema,
  DescribeResultSchema,
  KnowDeepDiveSchema,
  ReleaseResultSchema,
  ScoreResultSchema,
  TalkDeepDiveSchema,
  TalkDescribeResultSchema,
} from './schemas.js';
import { log } from './util.js';

/**
 * 設定したモデルが本番で使うスキーマを受け付けるかだけを、最小の呼び出しで確かめる。
 *
 * プロバイダを差し替えると、構造化出力のスキーマが受理されるかどうかが最初の関門になる。
 * 本番を 10 分回した末に落ちるより先に、数秒・数円で分かるようにしておく。
 *
 * **本番で送る形はすべて並べること。** 確かめたいのは項目数ではなく「その形が
 * 受理されるか」なので、形が違うものは 1 つでも欠かすと意味が無い。スキーマ検証が
 * 落ちるとバッチ全体がルールベースへ落ち、画面上はもっともらしいまま中身だけが
 * 失われる——この壊れ方は実行ログを見ないと気づけない。
 *
 *   npm run check:llm
 */
interface Case {
  name: string;
  schema: z.ZodType<unknown>;
  prompt: string;
  /** 深掘りは SUMMARY_MODEL 側で試す */
  deep?: boolean;
}

const CASES: Case[] = [
  { name: 'score', schema: ScoreResultSchema, prompt: '[0] テスト記事\n\n以上 1 件を採点してください。' },
  {
    name: 'describe',
    schema: DescribeResultSchema,
    prompt: '[0] テスト記事 — TypeScript 5.9 の新機能\n\n以上 1 件を要約してください。',
  },
  {
    name: 'release',
    schema: ReleaseResultSchema,
    prompt: '[0] Vite v8.2.0 released\n\n以上 1 件を判定してください。',
  },
  {
    name: 'community',
    schema: CommunitySpeakResultSchema,
    prompt: '[0] TSKaigi 2026 登壇者募集（LT 5分 × 6枠）\n\n以上 1 件を判定してください。',
  },
  {
    // 論点レーンだけ要約に「意見の足場」5 項目が乗るので、別スキーマになっている
    name: 'describe/talk',
    schema: TalkDescribeResultSchema,
    prompt: '[0] テスト記事 — モノレポをやめた理由\n\n以上 1 件を要約してください。',
  },
  {
    name: 'deep/know',
    schema: KnowDeepDiveSchema,
    prompt: 'npm の広範なパッケージが改ざんされた、という記事だとして深掘りしてください。',
    deep: true,
  },
  {
    name: 'deep/build',
    schema: BuildDeepDiveSchema,
    prompt: 'TypeScript 5.9 で satisfies 演算子が改善された、という記事だとして深掘りしてください。',
    deep: true,
  },
  {
    name: 'deep/talk',
    schema: TalkDeepDiveSchema,
    prompt: 'コードレビューは自動化すべきだ、と主張する記事だとして深掘りしてください。',
    deep: true,
  },
] as const;

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const backend = await getBackend();
  if (!backend) {
    log.error('LLM バックエンドがありません。ANTHROPIC_API_KEY か OPENAI_API_KEY を設定してください。');
    process.exit(1);
  }

  log.info(`採点/要約: ${cfg.rankModel}  深掘り: ${cfg.summaryModel}`);
  let failed = 0;

  for (const c of CASES) {
    const model = c.deep ? cfg.summaryModel : cfg.rankModel;
    const label = c.name.padEnd(13);
    const startedAt = Date.now();
    try {
      await complete(backend, {
        stage: `check:${c.name}`,
        model,
        maxTokens: 2000,
        system: '短く答えてください。内容の正しさは問いません。',
        prompt: c.prompt,
        schema: c.schema,
      });
      log.info(`  ✔ ${label} ${model} (${Date.now() - startedAt}ms)`);
    } catch (err) {
      failed++;
      log.error(`  ✘ ${label} ${model}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (failed > 0) {
    log.error(`\n${failed} 件のスキーマが通りませんでした。本番実行の前に解消してください。`);
    process.exit(1);
  }
  log.info(`\n${CASES.length} つとも通りました。`);
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
