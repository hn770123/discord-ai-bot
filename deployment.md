# Discord AI Bot — Deployment Guide

## 1. このBotのデプロイ方式
一般的なDiscord Botでは、プロセスを常時起動し Discord Gateway へ WebSocket 接続する構成が多い。

```text
一般的なBot
Discord Gateway
      ⇅ WebSocket
Bot Process
(VPS / Container / VM)
```

今回のBotはその方式を採らない。

```text
今回のBot
Discord
   │ HTTPS Interaction
   ▼
Cloudflare Worker
   │
   ├─ Discord REST API
   ├─ D1
   └─ LLM API

Cloudflare Cron
   └─ Scheduled Message
```

つまり「常駐Botプロセスをデプロイする」のではなく、**HTTP API + Serverless Job をデプロイする**感覚に近い。

## 2. 一般的なBotとの違い
| 項目 | 一般的なGateway Bot | 今回のBot |
|---|---|---|
| 実行方式 | 常駐プロセス | Cloudflare Worker |
| Discord受信 | Gateway WebSocket | HTTPS Interaction |
| 通常投稿監視 | リアルタイム | `/ai` 時にREST取得 |
| Slash Command | GatewayまたはHTTP | HTTP |
| サーバー | VPS / VM / Container等 | Cloudflare Workers |
| プロセス監視 | 必要 | 原則不要 |
| 再接続処理 | Gateway reconnect必要 | 不要 |
| リマインダー | 常駐timer/job等 | Cron Trigger |
| 状態保存 | DB等 | D1 |

今回の用途では「通常投稿へ即時反応しない」ため、Gatewayを持たないことが大きな簡略化になる。

## 3. Discord側の準備
Discord Developer Portal:
https://discord.com/developers/applications

### 3.1 Application作成
1. New Application
2. Bot設定を確認
3. Bot Tokenを発行
4. Public Keyを確認
5. Application IDを確認

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
```

Bot TokenはGitへ保存しない。

### 3.2 Bot権限
Guild Installで必要最小限を設定する。

```text
View Channels
Send Messages
Read Message History
```

Slash Command用に `applications.commands` を使用する。
Botを使わせたい家族サーバー、個人サーバーへInstall Linkから追加する。

### 3.3 Interaction Endpoint URL
Workerデプロイ後のURLを Developer Portal の Interaction Endpoint URL に設定する。
DiscordがEndpoint検証を行うため、PINGと署名検証に対応した状態で設定する。

## 4. Cloudflare側の準備
### 4.1 Worker
```bash
npm install -D wrangler
```

Cloudflareは現在、新規プロジェクトでは `wrangler.jsonc` を推奨している。

### 4.2 D1
D1のschemaは `migrations/` 以下の連番SQLを正本とする。初期schemaの
`migrations/0001_initial_schema.sql` には次のテーブルと、Reminder取得用のindexが含まれる。

```text
users
channel_checkpoints
reminders
allowed_guilds
allowed_users
```

DiscordのsnowflakeはJavaScriptやSQLiteの整数へ変換せず、精度を保つため `TEXT` のまま保存する。
適用済みmigrationを編集すると環境間でschemaが食い違うため、以後の変更は
`0002_<変更内容>.sql` のような新しいファイルを追加してロールフォワードする。

#### 4.2.1 Databaseの作成とbinding

Cloudflareへログインした端末で、運用に使用するD1を1つだけ作成する。

```bash
npx wrangler login
npx wrangler d1 create discord-ai-bot
```

コマンドが出力する `database_id` を控え、`wrangler.jsonc` の
`00000000-0000-0000-0000-000000000000` を実IDへ置換する。binding名 `DB` と
`database_name` は変更しない。実IDを反映した設定は組織の運用方針に従って管理する。

#### 4.2.2 schemaの適用

単一のリモートD1へ適用する。`list` で対象を確認し、`apply` 後にもう一度 `list` を実行して
未適用migrationが残っていないことを確認する。

```bash
npx wrangler d1 migrations list discord-ai-bot --remote
npx wrangler d1 migrations apply discord-ai-bot --remote
npx wrangler d1 migrations list discord-ai-bot --remote
```

ローカル開発用D1は別途作成せず、同じ設定を `--local` でローカル永続領域へ適用する。

```bash
npx wrangler d1 migrations apply discord-ai-bot --local
```

#### 4.2.3 allowlistの初期登録

schema適用後、利用を許可するDiscord Guild IDとUser IDを単一D1へ登録する。
以下のプレースホルダーを実値へ置換する。Discord snowflakeは引用符で囲み、数値へ変換しない。

```bash
npx wrangler d1 execute discord-ai-bot --remote \
  --command "INSERT INTO allowed_guilds (guild_id, enabled) VALUES ('<guild-id>', 1) ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled"
npx wrangler d1 execute discord-ai-bot --remote \
  --command "INSERT INTO allowed_users (user_id, enabled) VALUES ('<user-id>', 1) ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled"
```

登録結果は秘密情報や会話本文を含まない次のqueryで確認する。

```bash
npx wrangler d1 execute discord-ai-bot --remote \
  --command "SELECT guild_id, enabled FROM allowed_guilds; SELECT user_id, enabled FROM allowed_users"
```

## 5. Secrets
本番環境にはSecretsとして登録する。

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put OPENAI_API_KEY
```

Application IDは秘密情報ではないため通常設定でもよい。
APIキーやTokenを `vars` に置かない。
ローカル開発では `.dev.vars` または `.env` を使い、Git管理対象外にする。

## 6. Cron Trigger
Scheduled Message用に、たとえば1分ごとのCronを設定する。

```json
{"triggers":{"crons":["* * * * *"]}}
```

Cloudflare CronはUTC基準。Reminder時刻はUTCまたはoffset付き日時へ正規化する。
Cronの役割は通常会話取得ではなく、Scheduled Message配信だけに限定する。

配信処理は1回最大100件、60秒のlease、最大5試行で動作する。スモークテストではDiscordの一時エラー後に `pending` と `next_attempt_at` が更新されること、恒久的な4xxでは `failed` となること、成功時だけ `sent_at` が設定されることを確認する。送信成功直後かつD1更新前の停止では再送の可能性があるため、必要に応じて `reminders` の状態と対象チャンネルを照合する。

## 7. Slash Command登録
Application Command APIで `/ai` を登録する。
開発中はGuild Commandとして登録すると反映確認がしやすい。
自家用Botなら許可Guildだけを対象にGuild Commandのままでもよい。
Phase 4以降は `action` に `chat`／`list`／`cancel` があり、削除時は一覧に表示された `reminder_id` を渡す。コマンド定義の変更後は登録スクリプトを再実行する。

## 8. デプロイ

**D1作成 → `database_id` 設定 → migration適用 → Secret登録 → Workerデプロイ**の順に行う。Workerを先にデプロイすると、初回リクエストが未作成テーブルを参照するため、必ずmigrationの完了を先に確認する。

```bash
npx wrangler deploy
```

コマンド実行前にD1名と適用対象Git SHAを確認し、migration一覧とデプロイ結果をリリース記録へ残す。

デプロイ後:
1. Worker URL確認
2. Discord Developer PortalへInteraction Endpoint URL設定
3. `/ai` を対象Guildで実行
4. defer表示確認
5. Discord REST APIで履歴が読めるか確認
6. LLM応答確認
7. D1更新確認
8. Cronによる通知確認

## 9. 本番前チェック
### Discord
- [ ] Application ID確認
- [ ] Public Key確認
- [ ] Bot Token発行
- [ ] Guild Install設定
- [ ] View Channels
- [ ] Read Message History
- [ ] Send Messages
- [ ] `/ai` 登録
- [ ] Interaction Endpoint URL登録
- [ ] Message Content取得確認

### Cloudflare
- [ ] 単一のD1を作成
- [ ] `database_id` と `DB` bindingを確認
- [ ] D1 migrationとスモークテストを完了
- [ ] Secrets登録
- [ ] Worker deploy
- [ ] Cron Trigger
- [ ] Logs確認

### Bot設定
- [ ] allowed_guilds
- [ ] allowed_users
- [ ] 対象Channel確認
- [ ] 別Guildの会話が混ざらないことを確認
- [ ] Reminderのmention制御確認

## 10. セキュリティ上の重要点
Worker URLが外部から見えていること自体は問題ではない。
重要なのは処理前に必ず:

```text
Discord署名検証
  ↓
Guild allowlist
  ↓
User allowlist
```

を通すこと。

Bot TokenはWorkerからDiscord REST APIを呼ぶためだけに使い、クライアントへ返さない。
Discord投稿時は `allowed_mentions` を明示し、LLM生成文字列だけで予期しないmentionが発火しないようにする。

## 11. なぜこの方式にするか
このBotは次の性質を持つ。
- 家族・少人数利用
- 通常投稿へのリアルタイム反応は不要
- AIは `/ai` で明示的に呼ぶ
- AIが呼ばれた時点で直前の会話を読めればよい
- Scheduled Messageだけ定期処理が必要

そのためGateway常時接続を維持するメリットが小さい。
**HTTP Interaction + Discord REST API + D1 + Cron Trigger** に限定することで、Gateway接続・再接続・常駐プロセス監視を省く。

## 12. デプロイスモークテスト

単一のWorker、D1、Discord Application、Secretsを対象に、デプロイ対象SHAを記録してから次の順序で確認する。

1. `npm ci && npm run check` を実行する。
2. `npx wrangler d1 migrations list discord-ai-bot --remote` で未適用分を確認し、`migrations apply` 後に再度一覧を確認する。
3. `npx wrangler deploy` の出力にあるURLの `/health` が200と `cache-control: no-store` を返すことを確認する。
4. Discord ApplicationのInteraction Endpointを設定し、署名検証用PINGが成功することを確認する。
5. 許可外Userで `/ai` を実行し、ephemeral拒否となり外部APIが呼ばれないことをログで確認する。
6. 許可Userで基本会話、履歴0件、Reminder追加・一覧・取消を確認する。`@everyone` を含む応答でも通知されないことを確認する。
7. Reminderを期限到来させ、成功時だけ `sent` になることと、本人向け以外でmentionがないことを確認する。
8. `wrangler tail` で相関IDを検索し、token、key、会話全文、Briefが出力されていないことを確認する。

## 13. Rollback

WorkerコードはCloudflare dashboardのDeploymentsから直前の正常deploymentへ戻すか、記録済みの正常Git SHAをcheckoutして `npx wrangler deploy` で再デプロイする。rollback前に現在と復帰先のSHA、実行者、理由、時刻を障害記録へ残す。

D1 migrationは原則として巻き戻さない。既存Workerが読み書きできるよう、migrationは列・テーブル追加を基本とし、削除・rename・制約強化は「新構造追加 → 両対応コード → データ移行 → 旧構造削除」の複数リリースに分割する。コードrollback時も新しいschemaを残す。誤データ更新がある場合は、対象範囲を確認してD1 backup／Time Travelから別DBへ復元し、検証後に人間の承認を得て復旧する。

## 14. 障害対応表

| 症状／ログ分類 | 主な確認箇所 | 対応 | 利用者への表示 |
| --- | --- | --- | --- |
| `openai` + `timeout`／`network`／`server` | OpenAI status、model設定、30秒上限 | 外部障害なら待機して再実行。継続時は正常SHAへrollback | AIサービス用の固定文 |
| `openai` + `invalid_response` | Structured Output schema、model対応 | 保存がないことを確認し、model／prompt変更をrollback | AIサービス用の固定文 |
| `discord` + `401`／`403` | Secret更新、Bot権限、Channel access | Tokenを値を表示せず再登録し、権限を修復 | Discord通信用の固定文 |
| `discord` + `429`／`5xx` | Discord status、Reminderのattempt | Interactionは再実行、Reminderは自動backoffを監視 | Discord通信用の固定文 |
| `worker` + `internal` | D1 status、migration一覧、相関ID | 書込段階とcheckpointを確認し、必要ならコードrollback | 一般的な固定文 |
| Reminderが`processing`のまま | `lease_expires_at`、Cron、直前のDiscord投稿 | lease切れ後の再取得を確認。投稿済みなら二重送信リスクを評価 | 通常は表示なし |

調査では相関IDと状態コードを使い、環境変数一覧、リクエスト本文、Interaction token、Briefを出力しない。秘密情報の露出が疑われる場合はログ保存範囲を限定して確認し、Discord Bot TokenとOpenAI API keyを失効・再発行してWorker Secretを更新する。

## 15. 参考
Discord:
- https://docs.discord.com/developers/quick-start/getting-started
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/resources/message

Cloudflare:
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/d1/get-started/
