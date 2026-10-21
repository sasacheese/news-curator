import { z } from 'zod';
import type { RuntimeConfig } from './config.js';
import { complete, getBackend } from './llm.js';
import type { ToolEntry } from './types.js';
import { log, mapLimit, truncate } from './util.js';

/**
 * 道具 1 件に「何ができるか」「何の代わりになるか」「試すのに要るもの」を書かせる。
 *
 * 新しく台帳に入った道具だけが対象で、1 道具 1 回（described で管理）。
 * 道具の名前と元の説明文・見かけた記事の見出ししか渡さないので、Haiku で足りる。
 */
const ToolDescribeSchema = z.object({
  items: z.array(
    z.object({
      ref: z.number().int(),
      summary: z
        .string()
        .describe(
          '何ができる道具か。日本語1〜2文・80字以内。「〜できる。」の形で、できることを具体的に書く。評価語（便利・強力・革新的）は書かない。説明文から読み取れなければ、読み取れた範囲だけを書く。',
        ),
      replaces: z
        .string()
        .nullable()
        .describe(
          '何の代わりになるか。既存の有名な道具名を1〜2個、「Jest」「Postman・Insomnia」の形で。代わりではなく新しい種類のものなら null。',
        ),
      requires: z
        .array(z.string())
        .describe(
          '試すのに要るもの。0〜3個、各12字以内。「アカウント登録」「API キー」「有料プラン」「macOS のみ」「Docker」「GPU」など。説明文から読み取れないものは書かない。',
        ),
    }),
  ),
});

const BATCH = 15;

function render(t: ToolEntry, ref: number): string {
  const seen = t.signals
    .slice(-3)
    .map((s) => s.title)
    .filter(Boolean)
    .join(' / ');
  return [
    `[${ref}] ${t.name}（種類: ${t.kind}）`,
    `URL: ${t.homepage}`,
    t.description ? `説明: ${truncate(t.description, 400)}` : null,
    seen ? `見かけた記事: ${truncate(seen, 300)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function describeTools(
  tools: readonly ToolEntry[],
  cfg: RuntimeConfig,
): Promise<Map<string, Pick<ToolEntry, 'summary' | 'replaces' | 'requires'>>> {
  const out = new Map<string, Pick<ToolEntry, 'summary' | 'replaces' | 'requires'>>();
  if (tools.length === 0) return out;
  const b = await getBackend();
  if (!b) return out;

  const batches: ToolEntry[][] = [];
  for (let i = 0; i < tools.length; i += BATCH) batches.push(tools.slice(i, i + BATCH));

  await mapLimit(batches, 3, async (batch, bi) => {
    try {
      const parsed = await complete(b, {
        stage: 'tools:describe',
        model: cfg.rankModel,
        maxTokens: 6000,
        system:
          'あなたは開発者向けの道具を紹介するキュレーターです。渡された道具それぞれについて、' +
          '何ができるか・何の代わりになるか・試すのに要るものを、渡された情報から読み取れる範囲だけで書いてください。' +
          '推測で機能を足さないこと。入力されたすべての ref に 1 件ずつ返すこと。',
        prompt: batch.map((t, i) => render(t, i)).join('\n\n'),
        schema: ToolDescribeSchema,
      });
      for (const r of parsed.items ?? []) {
        const t = batch[r.ref];
        if (!t) continue;
        out.set(t.id, {
          summary: r.summary?.trim() || null,
          replaces: r.replaces?.trim() || null,
          requires: (r.requires ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 3),
        });
      }
    } catch (err) {
      log.warn(`  道具の要約 batch ${bi}: ${err instanceof Error ? err.message : err}`);
    }
  });
  return out;
}
