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
D1 Databaseを作成し、Workerへbindingする。
最低限のテーブル:

```text
users
messages
reminders
allowed_guilds
allowed_users
```

## 5. Secrets
本番環境にはSecretsとして登録する。

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put LLM_API_KEY
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

## 7. Slash Command登録
Application Command APIで `/ai` を登録する。
開発中はGuild Commandとして登録すると反映確認がしやすい。
自家用Botなら許可Guildだけを対象にGuild Commandのままでもよい。

## 8. デプロイ
```bash
npx wrangler deploy
```

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
- [ ] Worker deploy
- [ ] D1 binding
- [ ] D1 migration
- [ ] Secrets登録
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

## 12. 参考
Discord:
- https://docs.discord.com/developers/quick-start/getting-started
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/resources/message

Cloudflare:
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/d1/get-started/
