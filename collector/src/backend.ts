import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { log } from './util.js';

export interface CompleteOptions<T> {
  /** 使用量を集計する単位 */
  stage: string;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface CompleteResult<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface LlmBackend {
  readonly name: string;
  /** 課金されるか。ローカル開発用バックエンドは false */
  readonly metered: boolean;
  complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>>;
}

/* ------------------------------------------------------------------ *
 * 本番: Anthropic API
 * ------------------------------------------------------------------ */

function isLegacyModel(model: string): boolean {
  // Haiku 4.5 / Sonnet 4.5 世代は adaptive thinking と effort を受け付けない
  return /haiku-4-5|sonnet-4-5|opus-4-5|haiku-3|sonnet-3/.test(model);
}

/**
 * 許容値を JSON Schema の enum キーワードとして復元する。
 *
 * zodOutputFormat は Zod の enum を enum キーワードに落とさず、
 * description に `{enum: ["a","b"]}` と書くだけで返す。これだと
 * 生成時に制約が効かず、枠外の値が返る。実測で 25 件中 1 件が枠外の
 * カテゴリを返してバッチ全体の検証が落ちた。
 *
 * enum キーワードが載れば構造化出力の制約デコードが効き、
 * そもそも枠外の値が生成されなくなる。
 * description の書式が変わったら何もしない（今の挙動に戻るだけ）。
 */
function restoreEnums(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) restoreEnums(child);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.enum === undefined) {
    const m = obj.description.match(/enum:\s*(\[[^\]]*\])/);
    if (m?.[1]) {
      try {
        const values: unknown = JSON.parse(m[1]);
        if (Array.isArray(values) && values.length > 0) obj.enum = values;
      } catch {
        // 書式が想定と違うだけなので、制約なしのまま進める
      }
    }
  }
  for (const child of Object.values(obj)) restoreEnums(child);
}

function outputFormat<T>(schema: CompleteOptions<T>['schema']) {
  const format = zodOutputFormat(schema);
  restoreEnums(format);
  return format;
}

function createAnthropicBackend(): LlmBackend {
  const client = new Anthropic();

  return {
    name: 'anthropic',
    metered: true,
    async complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
      const legacy = isLegacyModel(opts.model);
      const res = await client.messages.parse({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
        output_config: {
          format: outputFormat(opts.schema),
          ...(legacy || !opts.effort ? {} : { effort: opts.effort }),
        },
        ...(legacy ? {} : { thinking: { type: 'adaptive' as const } }),
      });

      if (res.stop_reason === 'refusal') {
        throw new Error('モデルが応答を拒否しました (stop_reason=refusal)');
      }
      if (res.parsed_output == null) {
        throw new Error(`構造化出力を取得できませんでした (stop_reason=${res.stop_reason})`);
      }

      return {
        value: res.parsed_output as T,
        usage: {
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * ローカル開発: Claude Code CLI 経由
 *
 * ローカルでログイン済みの Claude Code を Vercel AI SDK 経由で呼ぶ。
 * API キー不要で、従量課金ではなくサブスクリプションの枠で動く。
 *
 * ⚠️ ローカル開発・検証専用。
 * サブスクリプションの OAuth 認証は Claude Code とそれをラップする層のための
 * ものであり、プロダクトの LLM バックエンドとして常用するのは Anthropic の
 * ポリシーに反する。CI では下の selectBackend() が明示的に拒否する。
 * ------------------------------------------------------------------ */

/** API のモデル ID を Claude Code のエイリアスに寄せる */
function toClaudeCodeModel(model: string): string {
  if (/haiku/.test(model)) return 'haiku';
  if (/sonnet/.test(model)) return 'sonnet';
  if (/fable/.test(model)) return 'fable';
  if (/opus/.test(model)) return 'opus';
  return model;
}

async function createClaudeCodeBackend(): Promise<LlmBackend> {
  // 本番では読み込まれないよう動的 import にする（devDependencies のため）
  const [{ generateText, Output }, { createClaudeCode }] = await Promise.all([
    import('ai'),
    import('ai-sdk-provider-claude-code'),
  ]);

  // PATH 上の `claude` が壊れている環境があるので、Claude Code 本体のパスを優先する
  const executable = process.env.CLAUDE_CODE_EXECPATH || process.env.CLAUDE_CLI_PATH;
  const provider = createClaudeCode({
    defaultSettings: executable ? { pathToClaudeCodeExecutable: executable } : {},
  });

  return {
    name: 'claude-code',
    metered: false,
    async complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
      const { output, usage } = await generateText({
        model: provider(toClaudeCodeModel(opts.model)),
        system: opts.system,
        prompt: opts.prompt,
        output: Output.object({ schema: opts.schema }),
      });

      return {
        value: output as T,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadTokens: 0,
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 選択
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 比較用: OpenAI API
 * ------------------------------------------------------------------ */

/**
 * OpenAI のモデルか。段ごとにプロバイダを混ぜられるよう、
 * バックエンドはモデル ID で振り分ける（採点だけ Luna、深掘りは Sonnet、なども試せる）。
 */
export function isOpenAiModel(model: string): boolean {
  return /^(gpt|o[0-9])/.test(model);
}

/**
 * OpenAI の `response_format.json_schema.name` は `^[a-zA-Z0-9_-]+$` しか受け付けない。
 *
 * stage は使用量レポートの見出しでもあり、`score:know` のように区切り文字を含む。
 * 表示用の名前をそのまま API へ渡すと 400 で全リクエストが落ちる——実際に
 * レーン別の stage を導入した日に、採点・要約・深掘りの 3 段が丸ごと失敗した。
 * しかもリクエスト単位で握りつぶされるので、画面には「採点失敗」とだけ出る。
 *
 * stage の付け方を制約する（コロンを禁じる）のではなく、API に渡す境界で落とす。
 * 表示に適した名前と API が受け付ける名前は別物で、後者に前者を合わせる理由が無い。
 */
export function toSchemaName(stage: string): string {
  return stage.replace(/[^a-zA-Z0-9_-]/g, '_') || 'schema';
}

function createOpenAiBackend(): LlmBackend {
  const client = new OpenAI();

  return {
    name: 'openai',
    metered: true,
    async complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
      const res = await client.chat.completions.parse({
        model: opts.model,
        max_completion_tokens: opts.maxTokens,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        response_format: zodResponseFormat(opts.schema, toSchemaName(opts.stage)),
      });

      const choice = res.choices[0];
      if (choice?.message.refusal) {
        throw new Error(`モデルが応答を拒否しました: ${choice.message.refusal}`);
      }
      const parsed = choice?.message.parsed;
      if (parsed == null) {
        throw new Error(`構造化出力を取得できませんでした (finish_reason=${choice?.finish_reason})`);
      }

      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        value: parsed as T,
        usage: {
          // prompt_tokens はキャッシュ分を含むので、単価を分けるために差し引く
          inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
          outputTokens: res.usage?.completion_tokens ?? 0,
          cacheReadTokens: cached,
        },
      };
    },
  };
}

/**
 * モデル ID で振り分けるバックエンド。
 * RANK_MODEL と SUMMARY_MODEL に別プロバイダのモデルを指定できるようにするため。
 */
function createRouterBackend(anthropic: LlmBackend | null, openai: LlmBackend | null): LlmBackend {
  return {
    name: [anthropic?.name, openai?.name].filter(Boolean).join('+'),
    metered: true,
    async complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
      const backend = isOpenAiModel(opts.model) ? openai : anthropic;
      if (!backend) {
        throw new Error(
          `${opts.model} を呼ぶための API キーがありません` +
            `（${isOpenAiModel(opts.model) ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} を設定してください）`,
        );
      }
      return backend.complete(opts);
    },
  };
}

export async function selectBackend(): Promise<LlmBackend | null> {
  const requested = process.env.LLM_BACKEND?.trim();

  if (requested === 'claude-code') {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      throw new Error(
        'LLM_BACKEND=claude-code は CI では使えません。' +
          'サブスクリプション認証は Claude Code 自身のためのもので、' +
          'プロダクトの LLM バックエンドとして常用するのは Anthropic のポリシーに反します。' +
          'CI では ANTHROPIC_API_KEY を使ってください。',
      );
    }
    log.info('LLM バックエンド: claude-code（ローカル開発用・従量課金なし）');
    return await createClaudeCodeBackend();
  }

  const anthropic =
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
      ? createAnthropicBackend()
      : null;
  const openai = process.env.OPENAI_API_KEY ? createOpenAiBackend() : null;

  if (!anthropic && !openai) return null;

  /*
   * 片方しか無くても必ずルーター経由にする。
   * 素通しにすると、たとえば OPENAI_API_KEY だけの状態で RANK_MODEL が
   * claude-* のままだったときに、Anthropic のモデル名を OpenAI へ投げて
   * 404 になる。ルーターなら「どのキーが足りないか」で落ちる。
   */
  const backend = createRouterBackend(anthropic, openai);
  log.info(`LLM バックエンド: ${backend.name}（モデル ID で振り分け）`);
  return backend;
}
