/** 記事のカテゴリ。スキーマと UI の両方から参照するので独立させている。 */
export const CATEGORIES = [
  'リリース/アップデート',
  '新機能・新ツール',
  '設計・実装ノウハウ',
  'パフォーマンス',
  'AI/エージェント',
  'Web標準/ブラウザ',
  '調査・考察',
  'その他',
] as const;

export type Category = (typeof CATEGORIES)[number];
