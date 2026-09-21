# Discord AI Bot

Cloudflare Workers の HTTP Interaction と Cron Trigger で動作する、小規模な家族向け Discord AI Bot です。現在は開発基盤に加え、D1 schema と Repository 層を提供します。

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

| Method | Path      | 説明                          |
| ------ | --------- | ----------------------------- |
| `GET`  | `/health` | Worker の正常性を JSON で返す |

Discord Interaction、AI 応答、Reminder 配信は後続 Phase で実装します。

## 公式仕様（2026-09-21 確認）

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
