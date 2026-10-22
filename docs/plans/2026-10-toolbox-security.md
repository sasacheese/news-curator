# 実装計画: トレンド削除 / セキュリティ枠 / 道具箱

2026-10-20 の相談で確定した内容。フェーズ順に実装し、各フェーズは単独で PR にできる粒度にしてある。

## 確定事項

| 項目 | 決定 |
| --- | --- |
| トレンドタブ | 削除（今日タブの「動いている話題の帯」も含む） |
| 発掘タブ | 単独タブは廃止し、道具箱の入口の 1 つに統合 |
| 今日タブ | 作る・話すレーンは残す。セキュリティ専用枠を追加 |
| 道具箱 | 新タブ。選別より網羅（流量は多めでよい） |
| 退避 | 新着のまま 7 日放置で一覧から外す（削除はしない） |
| 分類軸 | 種類（誤ラベルのリスクが低いため） |
| X | 有料 API は使わない。「URL を貼って追加」経由のみ |
| 道具ノート | リポジトリ JSON（公開される前提） |

---

## Phase 0: トレンドの削除

**collector**
- `collector/src/trends.ts`・`trends.test.ts` を削除
- `index.ts` の trend 生成（L515 付近）と `saveTrendLedger` / `saveTrendBoard` 呼び出しを削除
- `store.ts`・`types.ts`・`config.ts`・`sources.ts` からトレンド関連の型・保存関数・設定を削除

**web**
- `views/TrendView.tsx`・`TrendBand.tsx`・`TrendCard.tsx` を削除
- `App.tsx` の `TABS` とルーティングから `trend` を外す。`#/trend` は `#/today` へリダイレクト
- `TodayView.tsx` から話題帯を外し、`api.ts`・`types.ts` から関連する型・取得処理を削除

**データ・ドキュメント**
- `data/trends/` は削除する（git 履歴に残るため復元できる）
- README の「トレンドは別のタブ」節と画面説明の該当箇所を削除

**完了条件**: `npm test` と型チェックが通る。今日タブがトレンドなしで描画される。

---

## Phase 1: 今日タブのセキュリティ枠

### ソースの追加
`config/watchlist.json` の feeds に、`category: "security"` を付けて追加する（フィード URL は実装時に疎通を確認する）。

- 国内: piyolog / Security NEXT / JPCERT/CC 注意喚起 / IPA 重要なセキュリティ情報
- 海外: BleepingComputer / The Hacker News / Krebs on Security / CISA KEV（JSON。新規追加分のみ）

### 選定
- `lanes.ts` に 4 本目のレーンとして `security` を足す。事前フィルタは「security カテゴリのフィード、または `CONSEQUENCE_TERMS` のうちセキュリティ語に一致するもの」
- 採点の問いは「この事案から、個人・企業が今日とるべき行動が具体的に引き出せるか」
- 深掘りは 1 日最大 3 件、残りは一覧で出す
- **インシデントの名寄せ**: 同じ事案（企業名＋事案の種類）は 1 件にまとめ、続報は「前回からの差分」だけを書く。名寄せの台帳は `data/security/incidents.json` に置く（直近 30 日分）

### カードの構成（深掘りの出力スキーマで固定）
1. 何が起きたか — 企業・被害規模・時系列
2. 攻撃手段 — 初期侵入 → 権限昇格 → 横展開 → 持ち出し（記事から読み取れた段階だけ書く）
3. 個人の対策 — 今日やることのチェックリスト
4. 企業の対策 — 技術・運用・組織に分けて書く
5. 自分に関係あるか — 使っているサービスや watchlist のパッケージとの照合
6. 出典 — 一次情報（企業の発表・JPCERT 等）を優先する

**UI**: `TodayView` のサマリーの直下に「セキュリティ」節を置く。目次に件数を出す。

**コスト**: 深掘り 3 件ぶん増える。1 日 +3〜5 円程度を見込み、実測してから枠を調整する。

---

## Phase 2: 道具箱の基盤

### データモデル
```ts
type ToolKind = 'cli' | 'library' | 'skill' | 'plugin' | 'mcp' | 'saas' | 'cloud' | 'other';
type ToolState = 'new' | 'interested' | 'prepared' | 'tried' | 'passed' | 'archived';

interface Tool {
  id: string;                    // 身元から作る（npm:<name> / gh:<owner>/<repo> / url:<host+path>）
  name: string;
  kind: ToolKind;
  identity: { npm?: string; github?: string; url?: string; marketplace?: string };
  summary: string;               // 何ができるか（1〜2 文）
  replaces?: string;             // 何の代わりになるか
  requires: string[];            // アカウント / API キー / 有料 / OS など
  trust: { official: boolean; author?: string; advisories: number; permissions?: string[] };
  signals: { source: string; at: string; note?: string }[];  // 入口ごとの観測履歴
  firstSeen: string; lastSignal: string;
  state: ToolState; stateAt: string; passReason?: string;
  tryPrompt?: string;            // 既存の try-prompt.ts で組む
  note?: ToolNote;               // 触ったあとの道具ノート（Phase 5）
}
```

- `data/tools/ledger.json` — 全件（退避したものも含む）。検索インデックスにも載せる
- `data/tools/board.json` — 一覧に並ぶものだけ（web はこれだけを読む）

### 種類の判定（ルールベース、迷ったら `other`）
| 判定材料 | 種類 |
| --- | --- |
| MCP Registry 由来、または `mcp` を名乗る package / repo | mcp |
| `SKILL.md` を持つ、またはスキルのマーケットプレイス由来 | skill |
| `.claude-plugin/plugin.json` を持つ、または Cursor / Claude のマーケットプレイス由来 | plugin |
| npm で `bin` を持つ、または release に単体バイナリがある | cli |
| npm で `bin` を持たない | library |
| クラウドの changelog 由来 | cloud |
| 上のどれでもない Web サービス | saas |

GitHub の判定はリポジトリのファイル一覧を API で 1 回取るだけにして、LLM は使わない。

### 入口A: 既存の収集から抽出（追加費用ゼロ）
- 作るレーン・その他の注目記事・リリース情報・Show HN・GitHub 急上昇のうち、`identityFromUrl` で身元が取れたものを登録する
- 発掘（`radar.ts`）の early / hidden も登録する。国内の厚みの計測値は `signals[].note` に残す
- `RadarView.tsx`・`RadarBoard.tsx` とタブは削除する。`radar.ts` は計測器として残す

### 一覧を絞る仕組み
- **退避**: `state === 'new'` のまま 7 日経ったら `archived` にする
- **再浮上**: 退避済みの道具に新しい信号（メジャーリリース・再言及・スターの急伸）が来たら `new` に戻し、「再浮上」バッジを付ける
- **並び順**: 信号の強さ × 新しさの減衰。種類ごとの棚に分けて表示する
- **見送りの学習**: 見送り理由（「同等品を使用中」「範囲外」など）を集計し、同じ種類・同じ置換先の道具の点数を下げる
- **上限**: 一覧の件数は多めに取る（初期値 300。運用して調整）

### UI（`views/ToolboxView.tsx`）
- タブの順は「今日 / 道具箱 / コミュニティ / アーカイブ / 検索」
- 上部に「準備済み（PC で触る）」のキュー、その下に種類別の棚
- カードには 名前・種類バッジ・何ができるか・何の代わりか・必要なもの・信頼の目印・試すプロンプト（既存の仕組み）を出す
- 状態の操作（気になる / 見送り）はスマホで押せる

### 状態の保存
- 操作は Firestore の `toolState/{toolId}` に書く（既存の Good/Bad と同じ方式で、同じように表示を限定する）
- collector が毎朝読み込んで `ledger.json` に反映する

**コスト**: summary・replaces・requires の生成に Haiku を使う。新規登録分だけなので 1 日数円。

---

## Phase 3: 入口B（道具専用のソース）

`collector/src/tools/` 以下にソースごとの取得処理を置き、`config/tools.json` で有効/無効と取得量を切り替える。

| ソース | 取り方 | 種類 |
| --- | --- | --- |
| Claude Code 公式プラグインのマーケットプレイス・`anthropics/skills` | マーケットプレイスの JSON / リポジトリの差分 | skill / plugin |
| awesome-claude-code など | README のリンクの差分 | 混在 |
| GitHub topic（`claude-code-plugin`・`claude-skills`・`mcp-server`・`cursor-rules`） | Search API。直近 N 日に作成されたもの | 混在 |
| MCP Registry | 公式 API の新着 | mcp |
| cursor.directory | 公開されている取得方法があれば使う。なければ見送る | plugin |
| npm | 週間ダウンロードの急伸（既存の計測を流用） | cli / library |
| AWS What's New / GCP リリースノート / Cloudflare・Vercel・Supabase の changelog | RSS。新製品・GA だけを残す | cloud |
| Product Hunt Developer Tools / Launch HN | RSS / 既存の HN 収集 | saas など |

各ソースは実装前に、取得方法・認証の要否・レート制限を確認する。取れないものは見送り、README に理由を残す。

---

## Phase 4: URL を貼って追加（X などから道具箱へ送る）

2026-10-21 の決定で、PWA の共有ボタン（Web Share Target）と iOS ショートカットは入れず、
**道具箱タブの「URL を貼って追加」欄だけ**にした（iOS は Web Share Target 非対応のため、どの端末でも使える入口に揃える）。

- 欄は貼られた URL を Firestore の `toolInbox/{id}` に書く（URL・時刻のみ。個人情報は載せない）
- collector が毎朝 inbox を読み、URL を解決して「気になる」として登録し、受付を消す
  - X の投稿 URL は **API を使わずに** oEmbed（`publish.twitter.com/oembed`）で本文を取得し、本文中のリンク（t.co は展開）から身元を取る
  - 取れなければ最初のリンクをサービスの URL とし、リンクが無ければ「未解決: ○○ の投稿」として登録する
  - 取りに行くのは https の公開ホストだけ（localhost・IP 直打ちは拒否）。1 回 30 件まで

---

## Phase 5: スマホでの下準備と道具ノート（仕様は別途詰める）

方向性だけ決まっている。

- 「準備する」で lab ディレクトリ（README＝課題・前提・所要時間＋スターター）を作り、状態を `prepared` にする
- 課題は種類ごとの型で出す（CLI は自分のリポジトリに当てる / ライブラリは比較実装 / Skill・Plugin は普段の作業 1 つ / クラウドは後片付けまで / MCP は実用途で接続）
- エージェントは準備役・伴走役にとどめ、手は自分で動かす
- 振り返りを道具ノートとして `ledger.json` に取り込む

**未決事項**: lab の置き場所（別リポジトリにするか、公開か非公開か）、準備を起動する手段（`workflow_dispatch` かクラウドセッションか）、振り返りの問いの型。

---

## 実装の順序と依存関係

```
Phase 0 ──┐
Phase 1 ──┼─ 互いに独立（触るファイルが重なるのは index.ts / TodayView.tsx だけなので、順に入れる）
Phase 2 ──┴→ Phase 3（入口の追加）
          └→ Phase 4（URL を貼って追加）
          └→ Phase 5（別途相談）
```
