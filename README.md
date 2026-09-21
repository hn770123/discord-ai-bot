# Discord AI Bot

Cloudflare Workers の HTTP Interaction と Cron Trigger で動作する、小規模な家族向け Discord AI Bot です。Phase 0 では開発基盤とヘルスチェックのみを提供します。

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

## 現在のエンドポイント

| Method | Path      | 説明                          |
| ------ | --------- | ----------------------------- |
| `GET`  | `/health` | Worker の正常性を JSON で返す |

Discord Interaction、D1 schema、AI 応答、Reminder 配信は後続 Phase で実装します。

## 公式仕様（2026-09-21 確認）

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/)
