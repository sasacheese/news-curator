import type { LlmBackend } from './backend.js';
import type { RuntimeConfig } from './config.js';
import { buildTryPrompt, identityFromUrl, releaseQuestions } from './try-prompt.js';
import { complete } from './llm.js';
import { ReleaseResultSchema } from './schemas.js';
import type {
  RawItem,
  ReleaseAlso,
  ReleaseImpact,
  ReleaseItem,
  ReleaseKind,
  TopicsConfig,
} from './types.js';
import { log, truncate } from './util.js';

/**
 * リリース情報の抽出。
 *
 * ランキング対象の記事とは性質が違う。「知っているか知らないか」だけで差が出るので、
 * 順位をつけずに全件出す。そのぶん 1 件あたりは短い要約にとどめる。
 */

/**
 * 表示順は impact（読者に何が起きるか）で決める。
 *
 * 以前は kind（メジャー/マイナー/パッチ/サービス）で並べていたが、これは
 * 仕様上の分類で読み手の関心と一致していなかった。実測 27 件では
 * service 15 件の中に「1 サンドボックスで複数エージェント実行」と
 * 「Server-Timing ヘッダーの通過」が同居し、minor のほうが
 * 「できるようになる」打率が高かった（4 件中 3 件）。
 *
 * 脆弱性は埋もれさせたくないので unlocks の次に置く。chore（修正のみ）は
 * 画面では畳む。
 */
const IMPACT_ORDER: Record<ReleaseImpact, number> = {
  unlocks: 0,
  security: 1,
  improves: 2,
  chore: 3,
};

/** kind は表示には使わないが、同一製品のまとめ判定に残している */
const KIND_ORDER: Record<ReleaseKind, number> = {
  'ai-model': 0,
  major: 1,
  minor: 2,
  patch: 3,
  service: 4,
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
  alsoReleased: ReleaseAlso[];
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
        .map((i) => ({ label: i.title.replace(/^\S+\/\S+\s+/, ''), url: i.url }))
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

# impact（読者に何が起きるか）
この読者が一番知りたいのは「これで何ができるようになるのか」です。
バージョンの上げ幅ではなく、**中身の変化の大きさ**で選んでください。

- unlocks — これまでできなかったことができるようになる。
  新しい API・新しい対応環境・新しい自動化・制限の撤廃など。
  パッチ番号の更新でも、中身が新機能なら unlocks です。
- security — 脆弱性の修正が主題。
- improves — できていたことが速い・安い・楽になる。性能改善・コスト削減・DX 改善。
- chore — 不具合修正だけ。新しくできることが増えない。

# unlock（何ができるようになるか）
「〜できるようになる」の形で 1 文、50字以内。読者の側から見て書きます。

- 良い例: 「インストールするだけでコードベースのナレッジグラフが生成され、コミットにも追従できる」
- 良い例: 「iPhone からも同じ拡張機能が使えるようになる」
- 悪い例: 「複数の回帰バグを修正」（できることが増えていない → null にして chore）
- 悪い例: 「v4.12.33 をリリース」（バージョンは答えになっていない）

**新しくできることが無ければ必ず null にしてください。** 埋めるために
「安定性が向上する」のような当たり障りのない文を書かないこと。

# changeBefore / changeAfter
変化の大きさは形容詞では伝わりません。対になる 2 つの短文で書きます。
- changeBefore: 「1 サンドボックスにエージェント 1 つ」
- changeAfter: 「1 サンドボックスで複数エージェントを分離実行」
記事から両方読み取れないときは、両方 null にしてください（片方だけは意味がない）。

# scope（新たに対応した環境）
対応範囲が広がったときだけ挙げます。例: iOS / Android / Web / CLI / セルフホスト / 無料プラン。
広がっていなければ空配列。既に対応していたものを並べないこと。

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
    c.alsoReleased.length
      ? `  同時リリース: ${c.alsoReleased.map((a) => a.label).join(', ')}`
      : null,
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
        // 判定できないので、畳まれる側に置く（あるように見せない）
        impact: 'chore',
        unlock: null,
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

    const merged = mergeSameProduct(out);
    log.info(
      `  リリース抽出: ${out.length}/${candidates.length} 件` +
        (merged.length !== out.length ? `（同一製品をまとめて ${merged.length} 件）` : ''),
    );
    return sortReleases(merged);
  } catch (err) {
    log.warn(`リリース抽出: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

interface ReleaseFields {
  product: string;
  what?: string | null;
  version: string | null;
  kind: string;
  impact?: string;
  unlock?: string | null;
  changeBefore?: string | null;
  changeAfter?: string | null;
  scope?: string[];
  summary: string;
}

/**
 * 中身の無い unlock を弾く。
 *
 * 「何ができるようになるか」を必須にすると、モデルは埋めるために
 * 「安定性が向上する」のような当たり障りのない文を書きたがる。
 * それが通ると chore が unlocks に混ざって、畳めなくなる。
 */
const EMPTY_UNLOCK = /^(なし|特になし|不明|null|-|—)$/i;
const VAGUE_UNLOCK =
  /(安定性が向上|信頼性が向上|品質が向上|より安定|バグが修正|不具合が修正|改善されている)/;

function cleanUnlock(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t || EMPTY_UNLOCK.test(t)) return null;
  if (VAGUE_UNLOCK.test(t)) return null;
  return t;
}

/**
 * 分類（impact）と本文（unlock）を食い違わせない。
 *
 * モデルは「大きな変更です」と言いながら中身を書けないことがある。
 * そのまま通すと unlocks の枠に空の項目が並び、畳む判断もできなくなる。
 * テキストが無ければ分類を下げ、テキストがあるのに chore と言っていれば
 * improves まで上げる（unlocks まで上げるのは踏み込みすぎ）。
 */
export function resolveImpact(
  declared: string | undefined,
  rawUnlock: string | null | undefined,
): { impact: ReleaseImpact; unlock: string | null } {
  const unlock = cleanUnlock(rawUnlock);
  const known = (IMPACT_ORDER as Record<string, number>)[declared ?? ''] != null
    ? (declared as ReleaseImpact)
    : 'chore';

  // 脆弱性は unlock の有無で判断しない（修正版の案内が unlock に入る）
  if (known === 'security') return { impact: 'security', unlock };
  if (known === 'unlocks' && !unlock) return { impact: 'chore', unlock: null };
  if (known === 'chore' && unlock) return { impact: 'improves', unlock };
  return { impact: known, unlock };
}

function toReleaseItem(c: Candidate, r: ReleaseFields): ReleaseItem {
  const kind = (KIND_ORDER as Record<string, number>)[r.kind] != null
    ? (r.kind as ReleaseKind)
    : 'minor';

  const { impact, unlock } = resolveImpact(r.impact, r.unlock);

  const before = r.changeBefore?.trim() || null;
  const after = r.changeAfter?.trim() || null;

  return {
    id: c.item.id,
    product: r.product?.trim() || c.item.sourceLabel,
    what: r.what?.trim() || null,
    version: r.version?.trim() || null,
    kind,
    impact,
    unlock,
    // 片方だけでは差分として読めないので、両方揃ったときだけ持つ
    change: before && after ? { before, after } : null,
    scope: (r.scope ?? []).map((v) => v.trim()).filter(Boolean).slice(0, 4),
    summary: r.summary?.trim() || '',
    title: c.item.title,
    url: c.item.url,
    sourceLabel: c.item.sourceLabel,
    publishedAt: c.item.publishedAt,
    alsoReleased: c.alsoReleased,
    /*
     * 試すプロンプトは URL から機械的に組む。GitHub Releases のタグ付き URL なら
     * その版を固定して clone できる。公式ブログの告知（料金改定・事業提携）は
     * 身元が取れないので null になる。
     */
    tryPrompt: buildTryPrompt(identityFromUrl(c.item.url), {
      goal: `${[r.product?.trim() || c.item.sourceLabel, r.version?.trim()].filter(Boolean).join(' ')} を入れて、${
        unlock ? `「${unlock}」を確かめる` : 'この版の変更を確かめる'
      }`,
      url: c.item.url,
      questions: releaseQuestions({ version: r.version, unlock }),
    }),
  };
}

/**
 * 同じ種類・同じ製品の項目を 1 件にまとめる。
 *
 * Vercel Changelog や GitHub Changelog は同じ製品の告知を 1 日に複数出す
 * （実測: Vercel 4 件 / GitHub Copilot 3 件 / Vercel AI Gateway 2 件）。
 * そのままだと同じ名前が並んで一覧が埋まるので、要約が最も厚いものを代表にし、
 * 残りは折りたたみに入れる。個別に辿れるよう URL は保持する。
 *
 * 種類はキーに含める。同じ製品でも minor と patch は重みが違うので混ぜない。
 */
function mergeSameProduct(items: ReleaseItem[]): ReleaseItem[] {
  const groups = new Map<string, ReleaseItem[]>();
  for (const item of items) {
    const key = `${item.kind}::${item.product.trim().toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const sorted = [...group].sort((a, b) => b.summary.length - a.summary.length);
    const primary = sorted[0]!;
    const extra: ReleaseAlso[] = sorted.slice(1).map((r) => ({ label: r.title, url: r.url }));
    return {
      ...primary,
      // 代表にバージョンが無く、まとめた側にあるなら拾う
      version: primary.version ?? sorted.find((r) => r.version)?.version ?? null,
      what: primary.what ?? sorted.find((r) => r.what)?.what ?? null,
      alsoReleased: [...primary.alsoReleased, ...extra].slice(0, 12),
    };
  });
}

/** 深刻度の高い脆弱性を security グループの先頭に出す */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

export function sortReleases(items: ReleaseItem[]): ReleaseItem[] {
  return [...items].sort((a, b) => {
    const byImpact = IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact];
    if (byImpact !== 0) return byImpact;
    if (a.advisory && b.advisory) {
      const bySeverity =
        (SEVERITY_ORDER[a.advisory.severity] ?? 9) - (SEVERITY_ORDER[b.advisory.severity] ?? 9);
      if (bySeverity !== 0) return bySeverity;
    }
    return b.publishedAt.localeCompare(a.publishedAt);
  });
}
