import type { Lane, RankedItem } from './types';

/**
 * レーンの表示定義。
 *
 * ラベルは収集側（collector/src/types.ts の LANE_LABELS）と同じ「知る／作る／話す」。
 * 以前は画面だけ「潮目／手札／論点」という含みのある語にしていたが、3 つ並べたときに
 * 体系が読めなかった（潮目=状況 / 手札=道具 / 論点=議題 で抽象度が揃っていない）うえ、
 * 語がレーンの実体からずれていた——「潮目」に入る記事の多くは大局の転換ではなく、
 * 自分に降ってくる事故や廃止の告知である。目的そのものを指す語のほうが迷わない。
 *
 * 意味の精度は見出し下の lead が担保する。
 */
export const LANE_META: { id: Lane; label: string; lead: string }[] = [
  {
    id: 'know',
    label: '知る',
    lead: '知らないと判断を間違えるもの。関心の外の話でも、規模が大きければここに入ります。',
  },
  {
    id: 'build',
    label: '作る',
    lead: 'できることが増えるもの。新しい道具と、今日そのまま動かせるものを集めています。',
  },
  {
    id: 'talk',
    label: '話す',
    lead: '立場が割れているもの。争点と両側の言い分を添えてあるので、そこから書き始められます。',
  },
];

/**
 * レーン導入前に生成した日のためのグループ定義。
 *
 * 過去のダイジェストは data/ にそのまま残っていて、日付を遡ると今でも表示される。
 * lane を持たない日に空の画面を見せないよう、旧来の ai / general での分け方を残す。
 */
const LEGACY_GROUPS = [
  { id: 'ai', label: 'AI', topLabel: 'AI のベスト' },
  { id: 'general', label: 'AI以外', topLabel: 'AI以外のベスト' },
] as const;

export interface ItemGroup<T> {
  /** 見出しと目次で共有する DOM id */
  id: string;
  label: string;
  lead?: string;
  items: T[];
}

/**
 * どこで使うグループか。
 * - top : 深掘りカードの見出し。「〜のベスト」と読ませる
 * - list: 一覧のタブ。狭いので短いラベルにする
 */
export type GroupVariant = 'top' | 'list';

/** その日のダイジェストがレーン方式で生成されているか */
export function hasLanes(items: readonly RankedItem[]): boolean {
  return items.some((i) => i.lane != null);
}

/**
 * 記事をレーン（旧い日は ai / general）でグループに分ける。
 * 中身が 0 件のグループは落とす——見出しだけがある空セクションは読み手を混乱させる。
 */
export function groupByLane<T extends RankedItem>(
  items: readonly T[],
  variant: GroupVariant,
): ItemGroup<T>[] {
  if (!hasLanes(items)) {
    return LEGACY_GROUPS.map((g) => ({
      id: `${variant}-${g.id}`,
      label: variant === 'top' ? g.topLabel : g.label,
      items: items.filter((i) => (i.domain === 'ai') === (g.id === 'ai')),
    })).filter((g) => g.items.length > 0);
  }

  return LANE_META.map((meta) => ({
    id: `${variant}-${meta.id}`,
    label: meta.label,
    // 一覧側でも出す。タブを切り替えたときに、そのレーンが何なのかを言い直す
    lead: meta.lead,
    items: items.filter((i) => i.lane === meta.id),
  })).filter((g) => g.items.length > 0);
}
