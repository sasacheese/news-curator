import type { LlmBackend } from './backend.js';
import type { RuntimeConfig } from './config.js';
import { complete } from './llm.js';
import { ReleaseResultSchema } from './schemas.js';
import type { RawItem, ReleaseItem, ReleaseKind, TopicsConfig } from './types.js';
import { log, truncate } from './util.js';

/**
 * リリース情報の抽出。
 *
 * ランキング対象の記事とは性質が違う。「知っているか知らないか」だけで差が出るので、
 * 順位をつけずに全件出す。そのぶん 1 件あたりは短い要約にとどめる。
 */

/**
 * 表示順。
 *
 * 「自分の手元を更新する判断が要るもの」を上に置く。
 * SaaS の機能追加（service）は数が多くなりがちで、実測でも 20 件中 13 件を占めた。
 * これを上に置くとライブラリのバージョン更新が下に埋もれるため、minor より下にする。
 */
const KIND_ORDER: Record<ReleaseKind, number> = {
  'ai-model': 0,
  major: 1,
  minor: 2,
  service: 3,
  patch: 4,
};

export const KIND_LABELS: Record<ReleaseKind, string> = {
  'ai-model': 'AIモデル',
  major: 'メジャー',
  service: 'サービス',
  minor: '機能追加',
  patch: 'パッチ',
};

interface Candidate {
  item: RawItem;
  /** 同時にリリースされた関連パッケージ */
  alsoReleased: string[];
  /** ソースの性質上リリースが確定しているもの（LLM の判定を待たない） */
  definite: boolean;
}

/**
 * モノレポは 1 日に大量のパッケージを同時リリースする
 * （実測: cloudflare/workers-sdk が 10 パッケージ）。
 * リポジトリ単位でまとめ、本文が最も厚いものを代表にする。
 */
function groupGithubReleases(items: RawItem[]): Candidate[] {
  const byRepo = new Map<string, RawItem[]>();
  for (const item of items) {
    const list = byRepo.get(item.sourceLabel) ?? [];
    list.push(item);
    byRepo.set(item.sourceLabel, list);
  }

  return [...byRepo.values()].map((group) => {
    const sorted = [...group].sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0));
    const primary = sorted[0]!;
    return {
      item: primary,
      // 代表以外はタイトルからリポジトリ名の接頭辞を落として並べる
      alsoReleased: sorted
        .slice(1)
        .map((i) => i.title.replace(/^\S+\/\S+\s+/, ''))
        .slice(0, 12),
      definite: true,
    };
  });
}

/**
 * リリース情報になりうるものを機械的に集める。
 * ここは再現率優先で広めに取り、最終判定は LLM に任せる。
 */
export function collectReleaseCandidates(
  items: RawItem[],
  window: { start: Date; end: Date },
): Candidate[] {
  const candidates: Candidate[] = [];

  candidates.push(...groupGithubReleases(items.filter((i) => i.source === 'github_release')));

  for (const item of items) {
    if (item.source === 'changelog') {
      candidates.push({ item, alsoReleased: [], definite: true });
    } else if (item.source === 'rss') {
      // 公式ブログにはリリース告知と事業発表が混ざるので LLM に判定させる
      candidates.push({ item, alsoReleased: [], definite: false });
    } else if (item.source === 'github_repo') {
      // 「急上昇」は 3 週間ぶんを拾っているので、当日作られたものだけを新規公開とみなす
      const created = new Date(item.publishedAt).getTime();
      if (created >= window.start.getTime() && created < window.end.getTime()) {
        candidates.push({ item, alsoReleased: [], definite: false });
      }
    }
  }

  return candidates;
}

function systemPrompt(topics: TopicsConfig): string {
  return `あなたは、あるソフトウェアエンジニア専属の技術情報キュレーターです。
渡された告知が「リリース情報」かどうかを判定し、リリースなら中身を要約してください。

# 読者プロフィール
${topics.profile}

# リリース情報とみなすもの
- 新しい AI モデルの公開
- 新しい API・SDK・ライブラリの公開
- 既存ライブラリの新バージョン（メジャー / マイナー / パッチいずれも）
- 機能が実験段階から GA（正式提供）になった告知
- SaaS・開発者向けサービスの機能追加

# リリース情報とみなさないもの（isRelease: false）
- 事業提携・資金調達・料金プランの発表
- 導入事例・ユーザーインタビュー
- 解説記事・チュートリアル・技術ブログ
- 「〜を振り返る」「〜の設計思想」のような読み物
- 機能の廃止・提供終了の告知（リリースではないため）

# 要約の書き方
- 「何が入ったか」を具体的に書く。「リリースされました」だけで終わらせない。
- バージョン番号・フラグ名・API 名は原文のまま正確に書く。
- 読者が使っていない技術でも、1 文で何の製品かわかるように書く。
- 日本語で書く。1〜2 文、80字程度に収める。
- 記事に書かれていない内容を推測で足さない。

# 出力
- 入力されたすべての ref に対して、必ず1件ずつ結果を返す。
- isRelease が false のものも、product と summary は空文字でよいので ref を返す。`;
}

function renderCandidate(c: Candidate, ref: number): string {
  const excerpt = truncate(
    (c.item.body || c.item.snippet).replace(/\s+/g, ' ').trim(),
    500,
  );
  return [
    `[${ref}] ${c.item.title}`,
    `  ソース: ${c.item.sourceLabel}`,
    c.alsoReleased.length ? `  同時リリース: ${c.alsoReleased.join(', ')}` : null,
    `  抜粋: ${excerpt || '(本文なし)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function extractReleases(
  backend: LlmBackend | null,
  candidates: Candidate[],
  topics: TopicsConfig,
  cfg: RuntimeConfig,
): Promise<ReleaseItem[]> {
  if (candidates.length === 0) return [];

  // LLM が無いときは、ソースの性質上確実なものだけを抜粋つきで出す
  if (!backend) {
    return candidates
      .filter((c) => c.definite)
      .map((c) => toReleaseItem(c, {
        product: c.item.sourceLabel.replace(/^GitHub Releases \/ /, ''),
        version: null,
        kind: 'minor',
        summary: truncate((c.item.body || c.item.snippet).replace(/\s+/g, ' ').trim(), 120),
      }));
  }

  const body = candidates.map((c, i) => renderCandidate(c, i)).join('\n\n');

  try {
    const parsed = await complete(backend, {
      stage: 'release',
      model: cfg.rankModel,
      maxTokens: 8000,
      system: systemPrompt(topics),
      prompt: `以下 ${candidates.length} 件を判定してください。\n\n${body}`,
      schema: ReleaseResultSchema,
    });

    const out: ReleaseItem[] = [];
    for (const r of parsed.items ?? []) {
      const c = candidates[r.ref];
      if (!c) continue;
      // GitHub Releases と CHANGELOG は定義上リリースなので、判定が false でも採用する
      if (!r.isRelease && !c.definite) continue;
      out.push(toReleaseItem(c, r));
    }

    log.info(`  リリース抽出: ${out.length}/${candidates.length} 件`);
    return sortReleases(out);
  } catch (err) {
    log.warn(`リリース抽出: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

function toReleaseItem(
  c: Candidate,
  r: { product: string; what?: string | null; version: string | null; kind: string; summary: string },
): ReleaseItem {
  const kind = (KIND_ORDER as Record<string, number>)[r.kind] != null
    ? (r.kind as ReleaseKind)
    : 'minor';
  return {
    id: c.item.id,
    product: r.product?.trim() || c.item.sourceLabel,
    what: r.what?.trim() || null,
    version: r.version?.trim() || null,
    kind,
    summary: r.summary?.trim() || '',
    title: c.item.title,
    url: c.item.url,
    sourceLabel: c.item.sourceLabel,
    publishedAt: c.item.publishedAt,
    alsoReleased: c.alsoReleased,
  };
}

function sortReleases(items: ReleaseItem[]): ReleaseItem[] {
  return [...items].sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
}
