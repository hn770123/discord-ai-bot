# Discord AI Bot

Cloudflare Workers の HTTP Interaction と Cron Trigger で動作する、小規模な家族向け Discord AI Bot です。署名検証と allowlist を通過した `/ai` に対し、同一チャンネルの会話履歴、User Brief、現在日時を使った構造化 AI 応答を提供します。

## 最初に読む場所

| 目的                                 | 文書                                        |
| ------------------------------------ | ------------------------------------------- |
| ローカルでコードを確認する           | この README の[ローカル開発](#ローカル開発) |
| 初回セットアップ／本番デプロイを行う | **[デプロイガイド](deployment.md)**         |
| 実装上の制約や障害時の挙動を確認する | [Implementation Notes](implementation.md)   |
| 構想・過去の実装計画を確認する       | [Draft](draft.md)／[実装計画](plan.md)      |

本番セットアップの正本は `deployment.md` です。認証情報の取得、Cloudflare へのログイン、D1、Secret、デプロイ、Discord の Endpoint とコマンド登録を、実行順に1本の手順として記載しています。README の断片的なコマンドをつなぎ合わせて本番作業を行わないでください。

## 構成

```text
Discord /ai ──署名付きHTTPS──> Cloudflare Worker
                                  ├── Discord REST API（履歴・応答）
                                  ├── Cloudflare Workers AI
                                  └── D1（allowlist・状態・予定）
Cloudflare Cron ───────────────> Worker ──> Discord（予定通知）
```

Gateway への常時接続は行いません。通常投稿は `/ai` 実行時に Discord REST API から取得します。

## 必要な環境

- Node.js 22（`.nvmrc` で固定）
- npm（Node.js 同梱版）

GitHub Codespaces では Dev Container が Node.js と推奨 VS Code 拡張を準備します。コンテナー作成後、またはローカル clone 後に依存関係を再現します。

```bash
npm ci
```

## ローカル開発

### 自動チェック

外部サービスの資格情報やネットワーク接続を使わず、lint、format、型、unit／integration test、空のローカルD1へのmigration適用を確認できます。

```bash
npm run check
```

統合テストだけを再実行する場合は `npm run test:integration` を使います。

### Worker とローカルD1

ローカルD1へmigrationを適用してから Worker を起動します。`--local` のD1操作とヘルスチェックにはCloudflare認証は不要です。Workers AIを実際に呼ぶ場合はリモートBinding用のCloudflareログインが必要です。

```bash
npx wrangler d1 migrations apply discord-ai-bot --local
npm run dev
```

別のターミナルでヘルスチェックを確認します。

```bash
curl -i http://localhost:8787/health
```

成功時は `200`、`cache-control: no-store`、`{"status":"ok"}` を返します。実際の Discord／Workers AI 疎通をローカルで試す場合だけ、Git対象外の `.dev.vars` に次の値を設定します。

```dotenv
DISCORD_PUBLIC_KEY=...
DISCORD_BOT_TOKEN=...
```

`.dev.vars` を共有・コミットしないでください。通常の自動テストと `/health` の確認にはこれらの値は不要です。

## 設定の要点

- Worker、D1、Discord Application は名前付き環境を分けず、各1つを運用します。
- `wrangler.jsonc` の `database_id` は現在設定済みです。初回作業でも無条件にD1を作り直さず、Cloudflare認証後にそのIDが対象アカウントに存在するか確認します。
- `CLOUDFLARE_AI_MODEL` と `DEFAULT_TIMEZONE` は秘密ではないため `wrangler.jsonc` の `vars` に置きます。
- `DISCORD_PUBLIC_KEY`、`DISCORD_BOT_TOKEN` は Worker Secret に置きます。
- Discord のコマンド登録にだけ使う `DISCORD_APPLICATION_ID` と `DISCORD_GUILD_ID` は、実行時のシェル環境変数として渡します。
- リモート操作では `--remote` を明示し、ローカルD1と取り違えないようにします。

認証方法、IDの取得場所、権限、コマンドを含む完全な手順は [デプロイガイド](deployment.md) を参照してください。

## `/ai` の機能

コマンド定義を変更した場合は、デプロイガイドの手順で登録スクリプトを再実行します。

| action         | 入力          | 動作                                                  |
| -------------- | ------------- | ----------------------------------------------------- |
| `chat`（既定） | `prompt`      | AIとの会話と、構造化出力による予定追加                |
| `list`         | なし          | 実行者が同じGuildで作成した予定を最大20件表示         |
| `cancel`       | `reminder_id` | 実行者が同じGuildで作成した未処理予定を論理キャンセル |

## エンドポイントと安全性

| Method | Path            | 説明                                                      |
| ------ | --------------- | --------------------------------------------------------- |
| `GET`  | `/health`       | Worker の正常性を JSON で返す                             |
| `POST` | `/interactions` | Discord署名、Interaction種別、allowlistを検証して応答する |

`/ai` は3秒以内に defer し、後続処理を `waitUntil()` へ登録します。最大100件の同一Guild／Channelの履歴、User Brief、現在日時と timezone を使って Cloudflare Workers AI を1回呼びます。入力・出力はWorker側でも検証し、通常応答では全mentionを無効化します。

Interaction body は64 KiB、prompt・AI応答・Brief・Reminder本文は各2000文字が上限です。Discord APIは10秒、Workers AIは30秒で打ち切ります。ログには相関IDとエラー分類だけを記録し、token、API key、会話全文、Briefは記録しません。

Cron は1回につき最大100件を処理し、60秒のleaseを取得します。通信失敗、HTTP 408、429、5xxは指数バックオフで最大5回まで再試行し、それ以外のDiscord 4xxまたは試行上限到達は `failed` とします。詳しい状態遷移と復旧方法は [Implementation Notes](implementation.md) とデプロイガイドの[障害対応](deployment.md#11-障害対応とrollback)を参照してください。

## 公式資料

外部サービスを設定する際は、デプロイガイド末尾の[公式資料](deployment.md#12-公式資料)から最新仕様を確認してください。
