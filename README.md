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

`config/sources.json` で管理しています。前日 7:00 〜 当日 7:00（JST）に公開されたものだけが対象です。

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

ソースを足したい / 減らしたいときは `config/sources.json` を編集してください（`enabled: false` でスキップ）。

## どう選んでいるか

```
収集(500件前後) → 重複排除 → 事前スコアリング(90件に絞る)
    → Claude Haiku 4.5 で全件採点 → ベスト3を Claude Sonnet 5 で深掘り
```

1. **重複排除** — URL 正規化・タイトル近似・過去に掲載済みの URL の 3 段階。同じ記事が翌日以降に再浮上しません
2. **事前スコアリング** — トピック適合度（68%）+ 人気度（22%）+ 一次情報ボーナス。LLM に渡す件数を絞ってコストを抑えます
3. **LLM 採点** — 読者プロフィールと関心トピックを渡し、「今日読む価値」を 0〜100 点で採点。一次情報を二次情報より高く、「〜してみた」系を低く評価するよう指示しています
4. **多様性の確保** — ベスト3は 1 ソース 1 本まで。同じ日に nodejs/node のリリースが 3 本出ても枠を独占しません
5. **深掘り** — 本文を取得して、概要 / 何ができるようになるか / 何が変わるか / 試し方 / なぜ重要か / 注意点 に構造化します

## 関心トピックを変える

**サイトの「設定」画面から編集できます。** トピック名・重要度(1〜5)・キーワードを、タグ入力の UI で複数追加・削除できます。

保存方法は 2 つ:

- **GitHub に保存** — Fine-grained personal access token（このリポジトリに `Contents: Read and write`）を一度貼っておくと、ブラウザから直接 `config/topics.json` をコミットできます。トークンはブラウザの localStorage にのみ保存され、送信先は api.github.com だけです
- **JSON をコピー** — トークンを使いたくない場合。コピーして `config/topics.json` に貼り付けてください

「読者プロフィール」欄も採点精度に直接効きます。使っている技術・立場・何に興味がないかを書くほど精度が上がります。

---

## ローカルで動かす

```bash
npm install
```

ダイジェストを生成する（`data/` に書き出します）:

```bash
ANTHROPIC_API_KEY=sk-ant-... GITHUB_TOKEN=$(gh auth token) npm run collect
```

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
| `RANK_CANDIDATES` | `90` | LLM に採点させる候補数。コストにほぼ比例します |
| `BODY_CHAR_LIMIT` | `12000` | 深掘り時に LLM へ渡す本文の最大文字数 |
| `CUTOFF_HOUR` | `7` | 集計の区切り時刻（JST） |

コストを下げたいとき — `RANK_CANDIDATES` を 60 に、`SUMMARY_EFFORT` を `low` に。
品質を上げたいとき — `SUMMARY_MODEL=claude-opus-5`、`SUMMARY_EFFORT=high` に。

---

## 保存されるデータ

| パス | 内容 |
| --- | --- |
| `data/digests/YYYY-MM-DD.json` | その日のダイジェスト全文（ベスト3の深掘り + その他） |
| `data/index/YYYY-MM.json` | 検索用の月別インデックス（タイトル・要約・キーワード・リンク） |
| `data/manifest.json` | 生成済みの日付・月の一覧 |

検索画面はこの月別インデックスを読み込んで、タイトル・要約・キーワード・トピックを対象に AND 検索します。
すべて Git 管理なので、`git log data/` で履歴も追えますし、`grep` でも探せます。

## 構成

```
collector/     収集・採点・要約（Node.js + TypeScript、GitHub Actions 上で実行）
web/           閲覧用の SPA（Vite + React、GitHub Pages で配信）
config/        トピック定義とソース定義（UI から編集可能）
data/          生成されたダイジェストと検索インデックス
```

## 注意点

- GitHub Actions の cron は**数分〜十数分遅れることがあります**。7:00 ちょうどに更新されないことがあります
- リポジトリを private にすると GitHub Pages の配信に GitHub Pro が必要になります。無料のまま private にしたい場合は、配信先を Cloudflare Pages に変えてください（`BASE_PATH=/` を渡してビルドします）
- Zenn・はてなブックマークの API は非公式のため、仕様変更で壊れる可能性があります。1 つのソースが落ちても、他のソースだけで処理は続行します
