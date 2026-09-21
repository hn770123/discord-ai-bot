# Discord AI Bot

Cloudflare Workers の HTTP Interaction と Cron Trigger で動作する、小規模な家族向け Discord AI Bot です。署名検証と allowlist を通過した `/ai` に対し、同一チャンネルの会話履歴、User Brief、現在日時を使った構造化 AI 応答を提供します。

## 必要な環境

- Node.js 22（`.nvmrc` で固定）
- npm（Node.js 同梱版）

GitHub Codespaces では Dev Container が Node.js と推奨 VS Code 拡張を準備します。コンテナー作成後、依存関係は次の 1 コマンドで再現できます。

```bash
npm ci
```

## ローカル開発

Worker を起動します。ローカル環境では秘密情報や Cloudflare アカウントは不要です。

```bash
npm run dev
```

別のターミナルからヘルスチェックを確認します。

```bash
curl -i http://localhost:8787/health
```

成功時は `200` と `{"status":"ok"}` を返します。すべての自動チェックは次のコマンドで実行できます。

```bash
npm run check
```

## 環境設定

`wrangler.jsonc` は `local`、`preview`、`production` を分離し、各環境に `DB` D1 binding と Cron の雛形を定義しています。リポジトリ内の D1 ID は無効なプレースホルダーです。Preview／Production のデータベース作成後、それぞれの `database_id` を実 ID に置換してからデプロイしてください。

```bash
npx wrangler d1 create discord-ai-bot-preview
npx wrangler d1 create discord-ai-bot-production
npx wrangler deploy --env preview
npx wrangler deploy --env production
```

資格情報は `vars` や Git 管理ファイルに書かず、対象環境へ Secret として登録します。ローカル値が必要になった場合は、Git 対象外の `.dev.vars.local` を使用します。

Discord Developer Portal の Application に表示される Public Key を環境ごとに登録します。値をコマンドライン引数へ直接書かず、対話プロンプトから入力してください。

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY --env preview
npx wrangler secret put DISCORD_PUBLIC_KEY --env production
npx wrangler secret put DISCORD_BOT_TOKEN --env preview
npx wrangler secret put DISCORD_BOT_TOKEN --env production
npx wrangler secret put OPENAI_API_KEY --env preview
npx wrangler secret put OPENAI_API_KEY --env production
```

デプロイ後、Developer Portal の **Interactions Endpoint URL** へ `https://<worker-host>/interactions` を設定します。Discord の検証用 PING を含め、このエンドポイントは有効な Ed25519 署名と5分以内の timestamp だけを受け付けます。

## `/ai` コマンド登録

登録スクリプトは Discord API v10 を使用します。環境変数は実行するシェルだけへ設定し、Git 管理ファイルやコマンド出力へ残さないでください。既定の `guild` scope は開発 Guild へ即時反映しやすい方式です。

```bash
export DISCORD_APPLICATION_ID='<application id>'
export DISCORD_BOT_TOKEN='<bot token>'
export DISCORD_GUILD_ID='<development guild id>'
npm run discord:register-command
```

本番で global command を選ぶ場合は scope を明示します。この場合 `DISCORD_GUILD_ID` は不要です。

```bash
export DISCORD_COMMAND_SCOPE='global'
npm run discord:register-command
```

Bot Token はコマンド登録に加え、Worker が Channel Messages API から履歴を取得するためにも必要です。`OPENAI_MODEL` と初回 User の `DEFAULT_TIMEZONE` は秘密ではない環境別変数として `wrangler.jsonc` に定義し、Bot Token と OpenAI API Key は必ず Secret にします。

## D1 migration

migration は `migrations/` の連番 SQL を正として管理します。適用前に未適用一覧を確認し、空DBへの初回適用と既存DBへのロールフォワードで同じコマンドを使います。データベース名を明記し、環境の取り違えを防いでください。

### Local

Cloudflare認証なしで、`wrangler dev --env local` と同じローカルD1へ適用します。

```bash
npx wrangler d1 migrations list discord-ai-bot-local --local --env local
npx wrangler d1 migrations apply discord-ai-bot-local --local --env local
```

空DBから再現性を確認する場合は、Git対象外の一時ディレクトリを指定できます。

```bash
rm -rf .wrangler/migration-check
npx wrangler d1 migrations apply discord-ai-bot-local --local --env local --persist-to .wrangler/migration-check
```

### Preview

先に `wrangler.jsonc` のPreview用 `database_id` を作成済みD1のIDへ置換し、Cloudflareへログインしてから実行します。

```bash
npx wrangler d1 migrations list discord-ai-bot-preview --remote --env preview
npx wrangler d1 migrations apply discord-ai-bot-preview --remote --env preview
```

### Production

Production用D1のバックアップ方針と対象名を再確認してから適用します。Previewで同じmigrationが成功していない状態では実行しません。

```bash
npx wrangler d1 migrations list discord-ai-bot-production --remote --env production
npx wrangler d1 migrations apply discord-ai-bot-production --remote --env production
```

適用後に再度 `migrations list` を実行し、未適用migrationがないことを確認します。D1は適用済みファイル名を `d1_migrations` に記録するため、適用済みSQLは編集せず、変更は次番号のmigrationとして追加します。

## 現在のエンドポイント

| Method | Path            | 説明                                                        |
| ------ | --------------- | ----------------------------------------------------------- |
| `GET`  | `/health`       | Worker の正常性を JSON で返す                               |
| `POST` | `/interactions` | Discord署名、Interaction種別、allowlistを検証して応答を返す |

許可された `/ai` は3秒以内の初期応答に余裕を持たせるため即時 defer し、後続処理を Worker の `waitUntil()` へ登録します。後続処理は最大100件の同一 Guild／Channel の履歴、User Brief、UTC現在日時と timezone を使って OpenAI Responses API を1回呼び、検証済みの応答・Brief・Reminderだけを反映します。通常応答は `allowed_mentions.parse = []` のため、生成文中の `@everyone`、`@here`、ユーザーメンションは通知を発生させません。

同じ Interaction が再処理された場合、Interaction ID を Reminder ID とすることで二重作成を抑止します。AI出力の取得または検証に失敗した場合は Brief、Reminder、checkpointを更新しません。Discord応答の編集に失敗した場合はDB更新済みでcheckpoint未更新となり、同一Interactionの再処理でReminderは重複せず、Briefは同じ値に収束します。運用時は秘密値や会話本文を表示せず、外部APIの状態コードとInteraction IDだけで障害箇所を調査してください。

## 公式仕様（2026-09-21 確認）

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [Discord: Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Discord: Application Commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord: Message / Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)
- [Discord: Allowed Mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object)
- [Cloudflare: Context (`waitUntil`)](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [OpenAI: Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI: Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
