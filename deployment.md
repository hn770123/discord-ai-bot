# Discord AI Bot — デプロイガイド

この文書は、単一の Discord Application、Cloudflare Worker、D1 を初めて構築し、その後更新するための**作業順の正本**です。各節の「移動先」を上から順に進めれば、Cloudflare と Discord を何度も往復する必要はありません。

> 秘密値をコマンド引数、Git管理ファイル、チャット、作業ログへ貼り付けないでください。`wrangler secret put` の対話入力、または実行中のシェル環境変数だけを使用します。

## 1. 全体の順序

| 順序 | 移動先 | 作業 | 完了の目印 |
| --- | --- | --- | --- |
| 1 | ローカル端末 | clone、依存関係、チェック | `npm run check` 成功 |
| 2 | Discord Developer Portal | Application作成、ID・鍵・Token取得、Install設定 | Botが対象Guildに参加 |
| 3 | Cloudflare Dashboard／端末 | 認証、D1確認、migration、allowlist、Secrets、deploy | `/health` が200 |
| 4 | Discord Developer Portal／端末 | Interaction Endpoint設定、`/ai` 登録 | Guildで `/ai` が表示 |
| 5 | Discord／Cloudflare | スモークテスト | 会話・予定・ログを確認 |

既存環境の更新は、[8. 通常の再デプロイ](#8-通常の再デプロイ)から開始できます。

## 2. ローカル端末で事前確認

Node.js 22 と npm を使います。対象Git SHAを記録し、自動チェックを完了します。

```bash
node --version
npm ci
npm run check
git rev-parse HEAD
```

本番操作はリポジトリのルートで行います。`package.json` に Wrangler が固定されているため、グローバル版ではなく `npx wrangler ...` を使用します。`npm install -D wrangler` の追加実行は不要です。

## 3. Discordを準備する（一度目の移動）

移動先: [Discord Developer Portal](https://discord.com/developers/applications)

### 3.1 Applicationと認証情報

1. **New Application** でApplicationを作成する（既存なら選択する）。
2. **General Information** で **Application ID** と **Public Key** を控える。
3. **Bot** でBot Userを作成する。Tokenが未発行、または値を失った場合だけ **Reset Token** で再発行し、**Bot Token**をパスワード管理ツールへ保存する。
4. 必要な値を次の対応で管理する。

| 値 | Portal上の場所 | 用途 | 保存先 |
| --- | --- | --- | --- |
| `DISCORD_APPLICATION_ID` | General Information / Application ID | コマンド登録 | 作業時のシェルのみ |
| `DISCORD_PUBLIC_KEY` | General Information / Public Key | Interaction署名検証 | Worker Secret |
| `DISCORD_BOT_TOKEN` | Bot / Token | Discord REST API・コマンド登録 | Worker Secret＋作業時のシェル |

Public Keyは公開情報に近い性質ですが、本リポジトリでは設定経路を統一するためWorker Secretとして登録します。Bot Tokenは第三者へ見せません。漏えい時はPortalで再発行し、Worker Secretも更新します。

### 3.2 Installationと権限

1. **Installation** で **Guild Install** を有効にする。
2. Default Install Settings のGuild Installへ `applications.commands` と `bot` scopeを追加する。
3. Bot permissionsは次だけを選ぶ。
   - View Channels
   - Send Messages
   - Read Message History
4. Portalが生成するInstall Linkを開き、対象Guildを選んで認可する。GuildへBotを追加できる権限を持つDiscordユーザーで承認する。
5. 対象チャンネルで、Botロールまたはチャンネル固有権限に同じ3権限があることを確認する。

このBotはGatewayを使わないため、Gateway Intentを受信処理には使用しません。ただし履歴本文がREST APIで期待どおり返るかは、最後のスモークテストで必ず確認します。大規模・認証済みApplicationでは、Discordの現行ポリシーに従ってMessage Contentに関する設定・承認要否も確認してください。

### 3.3 allowlist用ID

Discordクライアントの **User Settings → Advanced → Developer Mode** を有効にし、対象サーバーと利用者を右クリックして次を控えます。

- Guild ID（Server ID）
- User ID

IDはsnowflakeなので、SQLでは必ず文字列として引用符で囲みます。まだInteractions Endpointは設定しません。Worker URLが確定する[6章](#6-discordを仕上げる二度目で最後の移動)で設定します。

## 4. Cloudflareを構築する

ここからWorkerをデプロイするまで、Cloudflareの作業を続けて行います。

### 4.1 認証

人が操作する端末ではブラウザーOAuthを使用します。

```bash
npx wrangler login
npx wrangler whoami
```

ブラウザーで対象Cloudflareアカウントへのアクセスを承認し、`whoami` のAccount IDがデプロイ先と一致することを確認します。複数アカウントに所属している場合は、この確認を省略しないでください。

ブラウザーを使えないCIだけは、Cloudflare Dashboardで最小権限のAPI Tokenを作成し、CIのsecret storeから `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数として渡します。このリポジトリの通常CIへ本番Tokenを渡したり、値を `.env` や `wrangler.jsonc` へ保存したりしません。必要なToken権限は実行するWrangler操作に合わせ、Cloudflare公式の認証資料で最新の権限名を確認してください。

### 4.2 D1を確認または作成する

`wrangler.jsonc` には現在D1の実 `database_id` が設定されています。まず一覧を確認し、同じIDの `discord-ai-bot` が現在のアカウントに存在する場合は**新規作成しません**。

```bash
npx wrangler d1 list
```

初回構築などで対象D1が存在しない場合だけ作成します。

```bash
npx wrangler d1 create discord-ai-bot
```

出力された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` へ設定します。`binding` の `DB` と `database_name` の `discord-ai-bot` は変更しません。既存IDが別アカウントのものだった場合も、対象アカウントで作成したIDへ置き換えます。

### 4.3 migrationを適用する

リモート対象であることを明示し、適用前後に一覧を確認します。

```bash
npx wrangler d1 migrations list discord-ai-bot --remote
npx wrangler d1 migrations apply discord-ai-bot --remote
npx wrangler d1 migrations list discord-ai-bot --remote
```

未適用migrationが残っていないことを確認します。`migrations/` の適用済みSQLは編集せず、schema変更は次の連番ファイルで行います。

### 4.4 allowlistを登録する

3.3で控えたIDへ置き換えます。`<guild-id>` と `<user-id>` を残したまま実行しないでください。

```bash
npx wrangler d1 execute discord-ai-bot --remote \
  --command "INSERT INTO allowed_guilds (guild_id, enabled) VALUES ('<guild-id>', 1) ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled"

npx wrangler d1 execute discord-ai-bot --remote \
  --command "INSERT INTO allowed_users (user_id, enabled) VALUES ('<user-id>', 1) ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled"
```

登録結果を確認します。

```bash
npx wrangler d1 execute discord-ai-bot --remote \
  --command "SELECT guild_id, enabled FROM allowed_guilds; SELECT user_id, enabled FROM allowed_users;"
```

### 4.5 Worker Secretsを登録する

各コマンドの対話プロンプトが表示されてから値を貼り付けます。値をコマンド行へ連結しないため、shell historyに残りません。

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

登録名だけを確認します。値は表示されません。

```bash
npx wrangler secret list
```

`DISCORD_PUBLIC_KEY`、`DISCORD_BOT_TOKEN` の2件があることを確認します。`DISCORD_APPLICATION_ID` と `DISCORD_GUILD_ID` はWorker実行時に不要なのでSecretへ登録しません。

### 4.6 非秘密設定とCronを確認する

`wrangler.jsonc` で次を確認します。

- `ai.binding`: Workers AIを `env.AI` として公開する設定（現在は `AI`）
- `CLOUDFLARE_AI_MODEL`: 使用するJSON Mode対応Workers AIモデル
- `DEFAULT_TIMEZONE`: 初回Userの既定timezone（現在は `Asia/Tokyo`）
- `triggers.crons`: 予定通知の実行間隔（現在はUTC基準で毎分）
- `workers_dev`: `workers.dev` URLを発行する設定

Cronは通常会話取得ではなく、期限到来した予定通知だけを処理します。

### 4.7 Workerをデプロイする

D1 migrationとSecretsの確認後にデプロイします。

```bash
npx wrangler deploy
```

出力された `https://...workers.dev` のURLを `WORKER_URL` として控えます。URL末尾に `/interactions` はまだ付けません。まずヘルスチェックを行います。

```bash
export WORKER_URL='https://<worker-host>'
curl -i "$WORKER_URL/health"
```

`200`、`cache-control: no-store`、`{"status":"ok"}` を確認します。

## 5. Discordコマンド登録用の端末準備

3章で控えた値を、現在のシェルだけへ設定します。先頭に空白を入れても履歴保存を防げないshell設定があるため、共有端末では安全なsecret managerのCLI等を使用してください。

```bash
export DISCORD_APPLICATION_ID='<application-id>'
export DISCORD_GUILD_ID='<guild-id>'
read -rsp 'Discord Bot Token: ' DISCORD_BOT_TOKEN && export DISCORD_BOT_TOKEN && echo
```

既定は反映の速いGuild Commandです。家族向けの単一Guild運用ではこれを推奨します。

```bash
npm run discord:register-command
```

スクリプトは同名の `/ai` があれば更新し、なければ作成します。作業後はTokenをシェルから削除します。

```bash
unset DISCORD_BOT_TOKEN
```

Global Commandとして登録する明確な理由がある場合だけ、`DISCORD_COMMAND_SCOPE=global` を付けます。この場合 `DISCORD_GUILD_ID` は不要です。

```bash
DISCORD_COMMAND_SCOPE=global npm run discord:register-command
```

## 6. Discordを仕上げる（二度目で最後の移動）

移動先: Discord Developer Portalの対象Application

1. **General Information** の **Interactions Endpoint URL** に `$WORKER_URL/interactions` の実URLを入力する。
2. 保存する。Discordが署名付きPINGを送り、Workerが検証に成功すると保存が完了する。
3. 対象Guildで `/ai` が候補に現れることを確認する。

Endpoint保存に失敗した場合は、URLの `/interactions`、Workerのデプロイ、`DISCORD_PUBLIC_KEY` が同じApplication由来であることを確認します。`/health` URLをEndpointとして登録しないでください。

## 7. デプロイスモークテスト

次の順で確認し、対象Git SHAと結果をリリース記録へ残します。

1. 許可Userが `/ai prompt:短い質問` を実行し、defer後に応答される。
2. `/ai` 実行前の通常投稿が応答文脈へ反映され、履歴0件でも応答できる。
3. 許可外Userではephemeral拒否となり、Workers AIが呼ばれていないことをログで確認する。
4. `action:chat` で未来の予定を作り、`action:list` と `action:cancel` を確認する。
5. テスト用予定を期限到来させ、CronでDiscordへ投稿され、成功時だけD1が `sent` になることを確認する。
6. `@everyone` を含むAI応答で通知が発火せず、本人向け予定だけ本人へmentionされることを確認する。
7. ログを確認し、token、API key、Interaction token、会話全文、Briefが出力されていないことを確認する。

```bash
npx wrangler tail
```

履歴が空になる場合は、対象チャンネルの View Channels／Read Message History、Botの参加状態、Discord側のMessage Contentに関する現行要件、実APIレスポンスを確認します。

## 8. 通常の再デプロイ

Application、D1、Secretsが構築済みなら、サービスの初期設定は繰り返しません。

```bash
npm ci
npm run check
npx wrangler whoami
npx wrangler d1 migrations list discord-ai-bot --remote
npx wrangler d1 migrations apply discord-ai-bot --remote
npx wrangler d1 migrations list discord-ai-bot --remote
npx wrangler deploy
```

次の場合だけ追加作業を行います。

- コマンド定義を変更した: [5章](#5-discordコマンド登録用の端末準備)の登録を再実行する。
- Discord Applicationを変更した: Public Key、Bot Token、Application ID、Endpointをすべて対応させる。
- Tokenをローテーションした: 対応する `wrangler secret put` を再実行する。
- D1を変更した: 新しい `database_id` とallowlistを確認してからdeployする。

## 9. 本番前チェックリスト

### 認証と秘密情報

- [ ] `npx wrangler whoami` が対象Cloudflare Accountを示す
- [ ] Discord Application ID、Public Key、Bot Tokenが同じApplication由来
- [ ] Cloudflare Workers AIの利用上限を確認済み
- [ ] 2つのWorker Secret名を確認済み
- [ ] 秘密値がGit、shell history、ログへ残っていない

### Cloudflare

- [ ] `wrangler.jsonc` のD1 IDが対象アカウントのD1と一致
- [ ] リモートmigrationに未適用分がない
- [ ] allowlistに対象Guild／Userだけがある
- [ ] Worker deploy済み、`/health` が成功
- [ ] Cron Triggerが有効

### Discord

- [ ] Guild Installに `applications.commands` と `bot` scopeがある
- [ ] View Channels／Read Message History／Send Messagesが対象チャンネルで有効
- [ ] Interactions Endpointが `/interactions` を指す
- [ ] `/ai` が登録済み
- [ ] 実際の履歴本文を取得できる

## 10. セキュリティと運用上の注意

処理は必ず「Discord署名検証 → Guild allowlist → User allowlist」の順に通します。Bot TokenはDiscord REST APIの認証にだけ使用し、クライアントへ返しません。投稿時は `allowed_mentions` を明示し、LLM生成文だけで予期しないmentionが発火しないようにします。

Cronは1回最大100件、60秒のlease、最大5試行です。送信成功直後かつD1更新前に停止すると再送される可能性があるため、障害時は `reminders` の状態と対象チャンネルを照合します。

## 11. 障害対応とRollback

| 症状 | 主な確認箇所 | 対応 |
| --- | --- | --- |
| Endpointを保存できない | `/interactions`、Public Key、Worker URL | 同じDiscord ApplicationのPublic KeyをSecretへ再登録してdeploy |
| `/ai` が表示されない | Guild Install、command scope、Application/Guild ID | Guild commandを再登録し、登録時の状態コードを確認 |
| Discord 401／403 | Bot Token、チャンネル権限、Bot参加状態 | Tokenを再登録、権限を修復（値はログへ出さない） |
| Workers AI timeout／障害 | Workers AI status、model、30秒上限 | 外部障害なら待機。継続時は直前の正常設定へ戻す |
| Workers AI invalid response | modelのJSON Mode対応、schema | DB更新がないことを確認し、model／prompt変更を戻す |
| D1エラー | Account、database ID、migration | `whoami` とD1一覧、migration一覧を照合 |
| Reminderが`processing`のまま | `lease_expires_at`、Cron、Discord投稿 | lease切れ後の再取得と二重送信リスクを確認 |

WorkerコードはCloudflare DashboardのDeploymentsから直前の正常deploymentへ戻すか、記録済みの正常Git SHAをcheckoutして `npx wrangler deploy` します。現在と復帰先のSHA、実行者、理由、時刻を記録します。

D1 migrationは原則巻き戻しません。schema変更は「新構造追加 → 両対応コード → データ移行 → 旧構造削除」に分け、コードrollback時も新schemaを残します。誤データ更新はD1 backup／Time Travelから別DBへ復元・検証し、人間の承認後に復旧します。

秘密情報の露出が疑われる場合は、Discord Bot TokenとWorkers AI keyを失効・再発行し、Worker Secretを更新します。調査時も環境変数一覧、リクエスト本文、Interaction token、Briefを出力しません。

## 12. 公式資料

外部サービスの画面名、権限、CLI仕様は変更される可能性があります。作業直前に次の公式資料を確認してください。

### Discord

- [Getting Started](https://docs.discord.com/developers/quick-start/getting-started)
- [Installing your app](https://docs.discord.com/developers/quick-start/getting-started#installing-your-app)
- [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Application Commands](https://docs.discord.com/developers/interactions/application-commands)
- [Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)
- [Permissions](https://docs.discord.com/developers/topics/permissions)

### Cloudflare

- [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/#login)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

### Workers AI

- [Workers AI Binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Models](https://developers.cloudflare.com/workers-ai/models/)
