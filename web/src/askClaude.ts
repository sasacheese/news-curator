import { formatPublished, safeUrl } from './format';
import type { Debate, Prerequisite, RankedItem, ReleaseItem, TopItem } from './types';

/**
 * 読んだ記事の文脈を載せたまま Claude の新規チャットを開くための組み立て。
 *
 * API は使わない。プロンプトをクエリに載せた URL を開くだけなので、鍵も費用も
 * かからず、ログインしている本人のアカウントでそのまま会話が始まる。
 * iOS / Android ではこの URL が Claude アプリの Universal Link・App Link に
 * なっているため、アプリが入っていればアプリ側が開く（無ければ Web 版）。
 * デスクトップアプリを claude.ai のリンクの受け皿にはできないので、そちらは
 * ボタン側でプロンプトをクリップボードにも入れて貼れるようにしている。
 *
 * 用途は決め打ちしない。「使い方が分からない」「用語が分からない」「X に書くために
 * 理解したい」など聞きたいことは毎回違うので、こちらは文脈を積むだけにして、
 * どこを掘るかは Claude から聞かせる。
 */

const NEW_CHAT_URL = 'https://claude.ai/new';

/**
 * エンコード後の URL 長の上限。
 *
 * 日本語は 1 文字が `%E3%81%82` の 9 文字になるので、素の文字数の 9 倍で見積もる。
 * つまり実際に積める日本語は 900 字弱しかない。指示文だけで 3 分の 1 を使うため、
 * 指示は要点だけにして、空いた分を記事の中身に回している。
 *
 * 8000 の根拠は、URL とヘッダを合わせた受け取り側の上限（16KB 程度）から
 * Cookie などの分を引いた残り。ここを超える分は優先度の低い節から落とす
 * （落とした場合でもクリップボードには全文が入るので、貼れば失われない）。
 * 長すぎて開けない例が出たら、まずこの数値を下げる。
 */
const MAX_ENCODED_LENGTH = 8000;

export interface AskContext {
  /** 文中の呼び方。リリース情報にも同じボタンを置くため */
  subject: '記事' | 'リリース';
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt?: string;
  /** サイト側で付けた見出し。元題と違う切り口になっていることがある */
  headline?: string;
  /** サイト側の要約。行ごとに渡す */
  summary?: string[];
  prerequisites?: Prerequisite[];
  debate?: Debate | null;
  keywords?: string[];
  /**
   * あると効くが無くても会話が始まるもの（原文の抜粋など）。
   * 長いので、上限に当たったとき最初に落とす節にしている。
   */
  note?: { heading: string; body: string };
}

/** 長い項目を詰める。プロンプトの節がひとつで URL 上限を食い潰さないように */
function clamp(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? text.trim() : chars.slice(0, max - 1).join('') + '…';
}

function block(heading: string, lines: (string | null | undefined)[]): string | null {
  const body = lines.filter((l): l is string => Boolean(l && l.trim()));
  return body.length > 0 ? [heading, ...body].join('\n') : null;
}

function instruction(subject: AskContext['subject']): string {
  return [
    '---',
    `上の${subject}について話したい。まず原文を開いて確認し、読めなければ上の要約だけで進めて（その旨を言って）。`,
    '300 字程度で要点を説明し、専門用語はその場でほどいて。',
    'そのあと、私がどこを掘りたいか（使い方 / 用語 / 自分の仕事との関係 / SNS に書ける理解 など）を選択肢にして聞いて。番号で答える。',
  ].join('\n');
}

/**
 * @param maxEncodedLength URL に載せる場合の上限。クリップボードへ入れる分は
 *   長さの制約が無いので `Infinity` を渡して全節を残す。
 */
export function buildAskPrompt(
  ctx: AskContext,
  maxEncodedLength: number = MAX_ENCODED_LENGTH,
): string {
  const published = ctx.publishedAt ? formatPublished(ctx.publishedAt) : '';
  const head = block(`# ${ctx.subject}`, [
    `タイトル: ${ctx.title}`,
    `URL: ${safeUrl(ctx.url) ?? '(不明)'}`,
    `出典: ${ctx.sourceLabel}${published ? `（${published} 公開）` : ''}`,
  ])!;

  /*
   * 落としてよい節を、残したい順に並べる。上限を超えたら後ろから外す。
   * 争点より前提知識を残すのは、用語が分からないまま説明を読んでも進めないため。
   * キーワードを争点より後ろにしているのに、原文の抜粋より前にあるのは、
   * 数十文字しか使わないのに話題の範囲が伝わって割がいいから。
   */
  const optional = [
    block('# このサイトの要約', [
      ctx.headline,
      ...(ctx.summary ?? []).map((line) => clamp(line, 260)),
    ]),
    block(
      '# 記事を読むのに必要な前提知識（このサイトが補ったもの）',
      (ctx.prerequisites ?? [])
        .slice(0, 4)
        .map((p) => `- ${p.term}: ${clamp(p.explanation, 80)}`),
    ),
    ctx.debate
      ? block('# 争点', [
          ctx.debate.axis,
          `記事の立場: ${clamp(ctx.debate.forSide, 100)}`,
          `反対の立場: ${clamp(ctx.debate.againstSide, 100)}${
            ctx.debate.oneSided ? '（記事の外からの補い）' : ''
          }`,
        ])
      : null,
    block('# キーワード', [(ctx.keywords ?? []).slice(0, 8).join(', ')]),
    ctx.note ? block(`# ${ctx.note.heading}`, [clamp(ctx.note.body, 260)]) : null,
  ].filter((b): b is string => b !== null);

  const tail = instruction(ctx.subject);
  const assemble = (parts: string[]) => [head, ...parts, tail].join('\n\n');

  const parts = [...optional];
  while (parts.length > 0 && encodedLength(assemble(parts)) > maxEncodedLength) parts.pop();
  return assemble(parts);
}

function encodedLength(prompt: string): number {
  return NEW_CHAT_URL.length + 3 + encodeURIComponent(prompt).length;
}

export function claudeNewChatUrl(prompt: string): string {
  return `${NEW_CHAT_URL}?q=${encodeURIComponent(prompt)}`;
}

/* ---------- 各カードの形から AskContext を作る ---------- */

export function askContextForTop(item: TopItem): AskContext {
  return {
    subject: '記事',
    title: item.title,
    url: item.url,
    sourceLabel: item.sourceLabel,
    publishedAt: item.publishedAt,
    headline: item.deep.headline,
    summary: [item.deep.summary],
    prerequisites: item.deep.prerequisites,
    debate: item.debate,
    keywords: item.keywords,
    note: item.deep.whyItMatters
      ? { heading: 'このサイトが書いた「なぜ重要か」', body: item.deep.whyItMatters }
      : undefined,
  };
}

export function askContextForItem(item: RankedItem): AskContext {
  return {
    subject: '記事',
    title: item.title,
    url: item.url,
    sourceLabel: item.sourceLabel,
    publishedAt: item.publishedAt,
    summary: [item.oneLiner],
    debate: item.debate,
    keywords: item.keywords,
    note: item.snippet ? { heading: '原文の抜粋', body: item.snippet } : undefined,
  };
}

export function askContextForRelease(r: ReleaseItem): AskContext {
  return {
    subject: 'リリース',
    title: [r.product, r.version, r.what].filter(Boolean).join(' '),
    url: r.url,
    sourceLabel: r.sourceLabel,
    publishedAt: r.publishedAt,
    summary: [
      r.unlock ?? undefined,
      r.change ? `今まで: ${r.change.before} / これから: ${r.change.after}` : undefined,
      r.scope?.length ? `新たに対応: ${r.scope.join(', ')}` : undefined,
      r.advisory
        ? `脆弱性: ${r.advisory.cveId ?? r.advisory.ghsaId}（${r.advisory.packageName}、${
            r.advisory.patchedVersion ? `${r.advisory.patchedVersion} で修正` : '修正版なし'
          }）`
        : undefined,
      r.summary,
    ].filter((s): s is string => Boolean(s)),
  };
}

/** 検索結果の行（インデックス）から。要約はキュレーション時の 1 行だけ持っている */
export function askContextForIndexEntry(entry: {
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt: string;
  summary: string;
  keywords: string[];
}): AskContext {
  return {
    subject: '記事',
    title: entry.title,
    url: entry.url,
    sourceLabel: entry.sourceLabel,
    publishedAt: entry.publishedAt,
    summary: [entry.summary],
    keywords: entry.keywords,
  };
}
