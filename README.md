# news-curator

関心のあるトピックの最新情報を、**毎朝 7:00 に「前日 7:00 からの 24 時間」ぶんだけ集めて、30 分でキャッチアップできる形に要約する**ツールです。

- 収集・要約は GitHub Actions が毎朝 7:00 JST に実行します（PC を起動していなくても動きます）
- 結果は GitHub Pages の静的サイトで読みます（スマホからも見られます）
- 概要・リンク・キーワードは Git 管理の JSON に貯まるので、「あれ何だっけ」をあとから全文検索できます

サーバー費用は **0 円**（public リポジトリの GitHub Actions + Pages は無料枠）。かかるのは Claude API の実費だけで、**1 日およそ 20〜30 円 / 月 700〜900 円**が目安です。

---

## セットアップ

### 1. リポジトリを push する

```bash
git push -u origin main
```

### 2. Claude API キーを Secrets に登録する

[Anthropic Console](https://console.anthropic.com/settings/keys) で API キーを発行し、
リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で登録します。

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

> キーを登録しなくてもツールは動きますが、スコアリングがキーワードマッチだけになり、
> 「何ができるようになるか」「試し方」の解説は生成されません。

任意で、Qiita API のレート制限（未認証は 60 リクエスト/時）を緩めたい場合は `QIITA_TOKEN` も登録できます。

### 3. GitHub Pages を有効にする

**Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。

### 4. 最初のダイジェストを生成する

**Actions → Daily digest → Run workflow** を実行します。2〜3 分で
`https://<あなたのユーザー名>.github.io/news-curator/` にダイジェストが出ます。

以降は毎朝 7:00 JST に自動で更新されます。

---

## 何をどこから集めているか

前日 7:00 〜 当日 7:00（JST）に公開されたものだけが対象です。設定は 2 つに分かれています。

- `config/watchlist.json` — **どこを監視するか**（リポジトリ・フィード・CHANGELOG）。運用中に増減する部分
- `config/sources.json` — 各ソースの有効/無効と取得量のチューニング

| ソース | 内容 |
| --- | --- |
| Qiita | 全新着記事（LGTM・ストック数つき） |
| Zenn | daily トレンド + 新着 |
| はてなブックマーク | テクノロジーカテゴリのホットエントリー |
| Hacker News | 一定スコア以上のストーリー |
| dev.to | リアクション数の多い記事 |
| GitHub Releases | ウォッチ対象 35 リポジトリのリリースノート（React / Next.js / TypeScript / Vite / Prisma / Zod / TanStack / Playwright / Claude Code / Codex など） |
| GitHub 急上昇リポジトリ | 直近 3 週間に作られてスターを集めているリポジトリ |
| 公式ブログ RSS | Chrome Developers / web.dev / V8 / MDN / Node.js / TypeScript / React / Next.js / Vite / Vercel / GitHub / Cloudflare / Google Cloud / OpenAI など 22 フィード |
| CHANGELOG | Claude Code の CHANGELOG.md |

ソースそのものを止めたいときは `config/sources.json` の `enabled: false` を使ってください。

### 監視対象の追加・削除

`config/watchlist.json` の 3 つの配列を編集するだけです。ダイジェスト画面の「リリース情報」の下に
現在の監視対象一覧と **GitHubで編集** リンクがあるので、そこから Web エディタを開いて
コミットすれば翌朝の実行から反映されます（ローカルに clone しなくても、トークンを用意しなくても構いません）。

```jsonc
{
  // GitHub Releases を見るリポジトリ。owner/repo
  "repos": ["facebook/react", "vitejs/vite"],
  // RSS / Atom。weight は事前スコアの下駄（1〜5、既定 3）で、一次情報ほど高く
  "feeds": [{ "label": "React Blog", "url": "https://react.dev/rss.xml", "weight": 5 }],
  // リリースノートを持たず CHANGELOG.md だけ更新するもの。url は raw、homepage は表示用（省略可）
  "changelogs": [{ "label": "Claude Code", "url": "https://raw.githubusercontent.com/…/CHANGELOG.md" }]
}
```

書式を外した項目は警告を出してスキップし、URL の重複も落とします。1 行の typo でその日の収集が
丸ごと止まることはありません。実行ログの `監視対象: リポジトリ N / フィード N / CHANGELOG N` で
実際に読まれた件数を確認できます。

## リリース情報は別枠

新しい AI モデル・新 API・ライブラリの新バージョン・GA 昇格・新規公開などは、
**ランキングせずに全件**を別セクションに出します。読む価値の順位ではなく
「知っているかどうか」だけで差が出る種類の情報だからです。

種類ごとにまとめ、手元を更新する判断が要るものを上に置きます。

| 種類 | 対象 |
| --- | --- |
| AIモデル | 新しいモデルの公開 |
| メジャー / 新規公開 | メジャー版・GA 昇格・新しいライブラリ |
| 機能追加 | マイナー版 |
| サービス | SaaS・開発者向けサービスの機能追加 |
| パッチ | 修正のみ |

実装上の工夫が 2 つあります。

- **モノレポの一括リリースをまとめます。** 実測で `cloudflare/workers-sdk` が
  1 日に 10 パッケージ同時リリースしていました。リポジトリ単位で 1 件にまとめ、
  残りは「同時リリース 9 件」の折りたたみに入れます
- **公式ブログのリリース以外を除外します。** Vercel Changelog や GitHub Changelog には
  事業提携・料金改定・導入事例が混ざるので、LLM に判定させて落とします。
  ただし GitHub Releases と CHANGELOG は定義上リリースなので判定を待たずに採用します

リリース情報はベスト3にも入りえます（重大なリリースは深掘りする価値があるため）。
その場合は「ベスト3で詳説」の印がつき、「その他の注目記事」からは除外されます。

## どう選んでいるか

```
収集(600件前後) → 重複排除 ─┬→ リリース情報を抽出（順位なし・全件）
                             └→ 事前スコアリング(150件に絞る)
                                 → Claude Haiku 4.5 で採点 → ベスト3を Claude Sonnet 5 で深掘り
```

1. **重複排除** — URL 正規化・タイトル近似・過去に掲載済みの URL の 3 段階。同じ記事が翌日以降に再浮上しません
2. **事前スコアリング** — トピック適合度（68%）+ 人気度（22%）+ 一次情報ボーナス。LLM に渡す件数を絞ってコストを抑えます
3. **LLM 採点** — 読者プロフィールと関心トピックを渡し、「今日読む価値」を 0〜100 点で採点。一次情報を二次情報より高く、「〜してみた」系を低く評価するよう指示しています
4. **多様性の確保** — ベスト3は 1 ソース 1 本まで。同じ日に nodejs/node のリリースが 3 本出ても枠を独占しません
5. **深掘り** — 本文を取得して、概要 / 何ができるようになるか / 何が変わるか / 試し方 / なぜ重要か / 注意点 に構造化します

## 関心トピックを変える

**サイトの「設定」画面から編集できます。** トピック名・重要度(1〜5)・キーワードを、タグ入力の UI で複数追加・削除できます。

収集処理は GitHub Actions 上で `config/topics.json` を読むので、編集内容は一度リポジトリへ
コミットする必要があります。手順は 3 ステップです。

1. **JSON をコピー** で画面の内容をクリップボードに取る
2. **GitHubで編集** で `config/topics.json` の Web エディタを開く
3. 貼り替えてコミットする（翌朝の実行から反映）

「読者プロフィール」欄も採点精度に直接効きます。使っている技術・立場・何に興味がないかを書くほど精度が上がります。

### 設定画面にアクセストークンは要りません

以前はブラウザに Fine-grained personal access token を貼って GitHub Contents API を
直接叩いていましたが、やめました。公開サイトの localStorage に write 権限付きの
トークンを常駐させる割に、書き込みの認可はリポジトリの権限そのもので足ります。
GitHub の Web エディタへ飛ばせば、ログイン済みで権限があれば編集でき、無ければできない。
リポジトリを private にしてもこの方式のまま動きます。

そのため設定画面には秘密が何も無く、タブも隠していません。訪問者が編集しても
変わるのはその人自身の localStorage だけです。

**過去にトークンを保存したことがある場合**、次にサイトを開いた時点で自動的に削除され、
その旨が画面に出ます。ただし削除しても失効はしないので、
[GitHub の設定](https://github.com/settings/personal-access-tokens)から revoke してください。

---

## ローカルで動かす

```bash
npm install
```

### 必要なトークン

| 変数 | 要否 | 用途 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 実質必須 | GitHub Releases 35リポジトリ＋検索で 1 回あたり約 40 リクエスト。未認証は 60/時なので、続けて実行すると打ち止めになります。`$(gh auth token)` で足ります |
| `ANTHROPIC_API_KEY` | 本番のみ | ローカルで `LLM_BACKEND=claude-code` を使う場合は不要 |
| `QIITA_TOKEN` | 任意 | 未認証 60/時に対して 1 回 8 リクエストなので通常は不要 |

トークンが無くても各ソースは個別に握りつぶされて処理は続行しますが、
GitHub Releases が丸ごと落ちるとリリースノート由来の記事が拾えなくなります。

ダイジェストを生成する（`data/` に書き出します）:

```bash
ANTHROPIC_API_KEY=sk-ant-... GITHUB_TOKEN=$(gh auth token) npm run collect
```

### API キーを使わずに生成する（ローカル開発用）

ログイン済みのローカル Claude Code CLI 経由で LLM を呼べます。API キー不要・従量課金なしで、
Claude Code のサブスクリプション枠で動きます（[ai-sdk-provider-claude-code](https://github.com/ben-vargas/ai-sdk-provider-claude-code) を利用）。

```bash
LLM_BACKEND=claude-code GITHUB_TOKEN=$(gh auth token) npm run collect
```

> [!IMPORTANT]
> **ローカル開発・検証専用です。** サブスクリプションの OAuth 認証は Claude Code と
> それをラップする層のためのもので、プロダクトの LLM バックエンドとして常用するのは
> Anthropic のポリシーに反します。CI で `LLM_BACKEND=claude-code` を指定すると
> 明示的にエラーで止まります。本番は必ず `ANTHROPIC_API_KEY` を使ってください。

技術的にも本番向きではありません。実測で比較すると:

| | Anthropic API 直接 | Claude Code CLI 経由 |
| --- | ---: | ---: |
| 入力トークン（採点150件） | 約 54,000 | 291,762 |
| 所要時間（全工程） | 約 30 秒 | 約 7 分 |
| 費用 | 約 $0.19 | $0（サブスク枠） |

エージェントハーネスを経由するぶんトークンも時間も大きく増えます。プロンプトを
いじって出力を確かめる用途には十分ですが、毎朝の自動実行には向きません。

**LLM 側に必要なものはありません。** provider が依存する `@anthropic-ai/claude-agent-sdk` が
CLI を同梱していて、認証は macOS キーチェーンに保存済みの Claude Code のログインを使います。
`claude` コマンドが PATH に無くても（mise のシムが壊れていても）動きます。

別のビルドを使いたい場合だけ `CLAUDE_CLI_PATH` で実体を指定できます。

保存せずに結果だけ見る:

```bash
npm run collect:dry
```

過去の日付を指定する:

```bash
npm run collect -- --date=2026-07-30
```

サイトを開く:

```bash
npm run dev
```

http://localhost:5173/news-curator/ が開きます。`data/` と `config/` は dev サーバーが直接配信します。

---

## チューニング

環境変数（GitHub では **Settings → Secrets and variables → Actions → Variables**）で調整できます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `RANK_MODEL` | `claude-haiku-4-5` | 採点に使うモデル。安さ優先 |
| `SUMMARY_MODEL` | `claude-sonnet-5` | 深掘りに使うモデル。`claude-opus-5` にすると品質は上がるがコストも上がる |
| `SUMMARY_EFFORT` | `medium` | 深掘りの思考量。`low`〜`max` |
| `TOP_N` | `3` | 深掘りする件数 |
| `OTHER_N` | `12` | 「その他の注目記事」の件数 |
| `RANK_CANDIDATES` | `150` | LLM に採点させる候補数。採点は2段階なので、増やしても効くのは安い1段目の入力だけです |
| `BODY_CHAR_LIMIT` | `12000` | 深掘り時に LLM へ渡す本文の最大文字数 |
| `CUTOFF_HOUR` | `7` | 集計の区切り時刻（JST） |

コストを下げたいとき — `SUMMARY_EFFORT` を `low` に、`OTHER_N` を減らす。
品質を上げたいとき — `SUMMARY_MODEL=claude-opus-5`、`SUMMARY_EFFORT=high` に。

`RANK_CANDIDATES` を絞るのは割に合いません。45 まで下げる案を実データで検証したところ、
46〜60 位の帯に実際にベスト3入りした記事が含まれていました。削減額は月 ¥80 程度です。

実際にかかった費用は毎回 `data/digests/YYYY-MM-DD.json` の `usage` に工程別で記録され、
サイト末尾にも表示されます。調整の判断はそちらの実測値を見てください。

---

## 保存されるデータ

| パス | 内容 |
| --- | --- |
| `data/digests/YYYY-MM-DD.json` | その日のダイジェスト全文（ベスト3の深掘り + リリース情報 + その他） |
| `data/index/YYYY-MM.json` | 検索用の月別インデックス（タイトル・要約・キーワード・リンク） |
| `data/manifest.json` | 生成済みの日付・月の一覧と、生成元リポジトリ（設定編集リンク用） |

検索画面はこの月別インデックスを読み込んで、タイトル・要約・キーワード・トピックを対象に AND 検索します。
すべて Git 管理なので、`git log data/` で履歴も追えますし、`grep` でも探せます。

## 構成

```
collector/     収集・採点・要約（Node.js + TypeScript、GitHub Actions 上で実行）
web/           閲覧用の SPA（Vite + React、GitHub Pages で配信）
config/        トピック定義・監視対象・ソース定義
data/          生成されたダイジェストと検索インデックス
```

## 注意点

- GitHub Actions の cron は**数分〜十数分遅れることがあります**。7:00 ちょうどに更新されないことがあります
- リポジトリを private にすると GitHub Pages の配信に GitHub Pro が必要になります。無料のまま private にしたい場合は、配信先を Cloudflare Pages に変えてください（`BASE_PATH=/` を渡してビルドします）
- Zenn・はてなブックマークの API は非公式のため、仕様変更で壊れる可能性があります。1 つのソースが落ちても、他のソースだけで処理は続行します
