import Anthropic from '@anthropic-ai/sdk';
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
          format: zodOutputFormat(opts.schema),
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

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return createAnthropicBackend();
  }

  return null;
}
