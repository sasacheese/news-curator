import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { packageMatcher } from './advisories.js';
import { loadSources, loadTopics, loadWatchlist } from './config.js';

/*
 * watchlist から外したリポジトリのパッケージが、critical / high の
 * advisory 照合から消えていないことを固定する。
 *
 * 比較しているのは「置き換え前の packageMatcher が true にした名前とスコープ」。
 * 例外は二つだけ。
 * - query / router / table はリポジトリ名が一般語で、同名の無関係なパッケージまで当たる。
 *   TanStack の実体は extraScopes の tanstack と extraPackages の @tanstack/* で残す。
 * - facebook スコープは @facebook/* 全体に当たる。react 本体は react/react がカバーする。
 */

const OLD_REPOS = [
  'facebook/react',
  'vercel/next.js',
  'microsoft/TypeScript',
  'nodejs/node',
  'vitejs/vite',
  'vitest-dev/vitest',
  'rolldown/rolldown',
  'oven-sh/bun',
  'denoland/deno',
  'prisma/prisma',
  'drizzle-team/drizzle-orm',
  'colinhacks/zod',
  'TanStack/query',
  'TanStack/router',
  'TanStack/table',
  'axios/axios',
  'vercel/swr',
  'microsoft/playwright',
  'tailwindlabs/tailwindcss',
  'biomejs/biome',
  'oxc-project/oxc',
  'honojs/hono',
  'trpc/trpc',
  'shadcn-ui/ui',
  'anthropics/claude-code',
  'anthropics/anthropic-sdk-typescript',
  'openai/codex',
  'modelcontextprotocol/servers',
  'cloudflare/workers-sdk',
  'storybookjs/storybook',
  'pnpm/pnpm',
  'eslint/eslint',
  'remix-run/react-router',
  'expressjs/express',
  'supabase/supabase',
];

const OLD_EXTRAS = [
  '@tanstack/react-router',
  '@tanstack/react-query',
  '@anthropic-ai/sdk',
  '@anthropic-ai/claude-code',
];

const BARE_NAMES_NOT_RESTORED = new Set(['query', 'router', 'table']);

/** リリース監視から外しても、advisory では拾い続けたい実パッケージ */
const KEPT = [
  'axios',
  'express',
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  '@drizzle-team/drizzle-orm',
  'trpc',
  '@trpc/server',
  '@trpc/client',
  'eslint',
  '@eslint/js',
  'storybook',
  '@storybookjs/storybook',
  'hono',
  '@honojs/hono',
  'pnpm',
  '@pnpm/exe',
  'swr',
  '@vercel/swr',
  'react-router',
  '@remix-run/router',
  '@remix-run/react-router',
  '@tanstack/query',
  '@tanstack/router',
  '@tanstack/table',
  '@tanstack/react-query',
  '@tanstack/react-router',
  '@tanstack/react-table',
  '@tanstack/query-core',
  'biome',
  '@biomejs/biome',
  'oxc',
  '@oxc-project/oxc',
  'rolldown',
  '@rolldown/rolldown',
  'react',
  '@facebook/react',
];

function coverageOf(repos: readonly string[], extras: readonly string[], scopes: readonly string[] = []) {
  const names = new Set<string>();
  const scopeSet = new Set<string>();
  for (const repo of repos) {
    const [owner, name] = repo.toLowerCase().split('/');
    if (!owner || !name) continue;
    names.add(name);
    names.add(`@${owner}/${name}`);
    scopeSet.add(owner);
  }
  for (const extra of extras) names.add(extra.toLowerCase());
  for (const scope of scopes) scopeSet.add(scope.toLowerCase().replace(/^@/, ''));
  return { names, scopes: scopeSet };
}

describe('loadWatchlist / loadTopics', () => {
  it('承認済みの watchlist を落とさず読む', async () => {
    const watchlist = await loadWatchlist();
    assert.equal(watchlist.repos.length, 22);
    assert.equal(watchlist.feeds.length, 35);
    assert.equal(watchlist.changelogs.length, 1);
    assert.ok(watchlist.repos.includes('react/react'));
    assert.ok(watchlist.repos.includes('anthropics/claude-code'));
    assert.equal(watchlist.repos.includes('axios/axios'), false);
    assert.equal(watchlist.repos.includes('facebook/react'), false);
    assert.ok(watchlist.feeds.some((feed) => feed.label === 'piyolog' && feed.category === 'security'));
    assert.ok(watchlist.changelogs.some((entry) => entry.label.includes('Claude Code')));
  });

  it('承認済みの topics を設定画面と同じ形で読む', async () => {
    const topics = await loadTopics();
    assert.deepEqual(
      topics.topics.map((topic) => topic.name),
      [
        'クラウド / 本番環境構築',
        'AI支援開発・品質',
        'セキュアな開発',
        'AIプロダクトのUI/UX',
        'AIエージェント構築',
        'フロントエンドの新技術',
        'FDE / 業務改革',
        '成果の測り方・評価',
        'データ基盤',
        '言語 / ランタイム',
      ],
    );
    assert.ok(topics.profile.includes('FDE'));
    assert.ok(topics.exclude.keywords.includes('求人'));
    const cloud = topics.topics.find((topic) => topic.name.startsWith('クラウド'));
    assert.ok(cloud?.keywords.includes('iac '));
    assert.ok(topics.topics.every((topic) => topic.keywords.length > 0));
  });
});

describe('advisory のパッケージ集合', () => {
  it('外したリポジトリのパッケージを、前と同じかそれ以上に拾う', async () => {
    const sources = await loadSources();
    const before = coverageOf(OLD_REPOS, OLD_EXTRAS);
    const after = packageMatcher(
      sources.githubReleases.repos,
      sources.advisories.extraPackages,
      sources.advisories.extraScopes,
    );

    const lostNames = [...before.names]
      .filter((name) => !BARE_NAMES_NOT_RESTORED.has(name) && !after(name))
      .sort();
    assert.deepEqual(lostNames, [], `名前の照合が落ちた: ${lostNames.join(', ')}`);

    const lostScopes = [...before.scopes]
      .filter((scope) => scope !== 'facebook' && !after(`@${scope}/__coverage_probe__`))
      .sort();
    assert.deepEqual(lostScopes, [], `スコープの照合が落ちた: ${lostScopes.join(', ')}`);

    const lostKept = KEPT.filter((name) => !after(name));
    assert.deepEqual(lostKept, [], `指定パッケージが落ちた: ${lostKept.join(', ')}`);

    assert.equal(after('@facebook/metro'), false);
    assert.equal(after('query'), false);
    assert.equal(after('router'), false);
    assert.equal(after('table'), false);
    assert.equal(after('react'), true);
    assert.equal(after('@facebook/react'), true);
  });
});
