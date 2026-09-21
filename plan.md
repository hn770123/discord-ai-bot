# Discord AI Bot — Codex Cloud 実装計画

## 1. この計画の目的

`draft.md` の体験を、Codex Cloud で段階的に実装し、GitHub Codespaces と、Codespaces に接続したローカルの Visual Studio Code（以下 VS Code）から検証・デプロイできる状態にする。

初期版の完成条件は次のとおり。

- 許可された Guild / User が `/ai` でのみ AI を呼び出せる
- Bot は Discord Gateway に常時接続せず、Interaction と REST API だけを使用する
- AI は同じ Guild / Channel の前回参加以降の会話と User Brief を参照する
- AI 応答、Brief 更新、未来の Discord 投稿作成を一度の構造化出力で判断する
- Scheduled Message を Cloudflare Cron Trigger から重複なく配信する
- シークレットを Git、Codex Cloud の成果物、ログ、PR本文へ残さない
- Codespaces 内からテスト、マイグレーション、デプロイ、ログ確認を再現できる

## 2. 作業環境と責務の分離

### 2.1 Codex Cloud が担当すること

Codex Cloud は GitHub 上の対象リポジトリを接続し、機能単位のタスクをそれぞれ専用ブランチで実施する。

- ソースコード、テスト、D1 migration、設定テンプレート、運用手順の作成
- モックを使った自動テストと静的検査
- 実装差分のセルフレビュー
- コミット、push、PR作成
- PR上で失敗したCIへの修正

Codex Cloud には本番の Discord Bot Token、LLM API Key、Cloudflare API Token を渡さない。外部サービスの実接続がなくても完了できるよう、HTTP境界を薄いクライアントへ分離し、テストではモックする。

### 2.2 Codespaces / ローカル VS Code が担当すること

デプロイ作業の実体は Codespace 内で行う。ローカル VS Code は GitHub Codespaces 拡張機能から対象 Codespace を開き、そのターミナル、ポート、ファイル、拡張機能を利用する。

- PRのレビューとマージ
- Cloudflare / Discord / LLM の認証およびシークレット投入
- Preview / Production の D1 作成と migration 適用
- Worker のデプロイ
- Discord Developer Portal の設定
- 実Guildでのエンドツーエンド確認
- `wrangler tail` 等による本番ログ確認

ブラウザー上の Codespaces とローカル VS Code は同じ Codespace を操作するため、両者を別環境としてセットアップしない。手元のPCへ認証情報や依存関係を複製せず、コマンドは原則として Codespace のターミナルで実行する。

### 2.3 環境の区分

| 環境 | 用途 | 外部接続 | データ |
|---|---|---|---|
| Codex Cloud task | 実装、単体テスト、PR | モック中心 | テスト用一時DB |
| Codespaces local | 統合テスト、migration確認 | 開発用資格情報 | ローカルD1 |
| Cloudflare Preview | Discord疎通と受入テスト | 開発用Discord Application / LLM | Preview D1 |
| Cloudflare Production | 家族向け運用 | 本番用資格情報 | Production D1 |

Preview と Production では D1 database、allowlist、Worker secrets、Discord Application を分離する。少なくとも D1 と secrets は必ず環境別にする。

## 3. 実装開始前の仕様確認

外部サービスに依存するコードを変更するタスクでは、着手時に公式ドキュメントを再確認し、参照URLと確認日をPR本文へ記載する。ブログ記事や記憶だけでAPI仕様を決めない。

確認対象は以下とする。

1. **Codex Cloud**
   - GitHubリポジトリ接続、Environment の setup script / environment variables / secrets
   - タスクからのブランチ・PR運用、ネットワークアクセス制約
2. **Discord**
   - Interaction の Ed25519 署名検証、PING、3秒以内の初期応答、deferred response 編集
   - Application Command 登録、Channel Messages API、必要権限、Message Content の扱い
   - `allowed_mentions` の正確なリクエスト形式
3. **Cloudflare**
   - 最新 Wrangler 設定形式、Workers の `fetch` / `scheduled` handler
   - D1 binding、migration、transaction / batch の保証範囲
   - Cron Trigger、Secrets、Preview / Production 環境設定
4. **採用するLLM API**
   - 推奨API、利用可能なモデル、構造化出力のschema、タイムアウトとエラー形式
   - APIキーの管理方法、データ保持に関する設定

仕様確認の結果が既存の `implementation.md` または `deployment.md` と異なる場合は、実装前に両文書も同じPRで更新する。

## 4. 初期技術方針

- TypeScript、Cloudflare Workers、D1、Wrangler を使用する
- Worker はモジュール形式とし、`fetch()` と `scheduled()` を同一アプリケーションから公開する
- defer応答を返した後の処理は Execution Context の `waitUntil()` へ明示的に登録し、Workerが応答返却時に終了しない構成にする
- パッケージマネージャーと Node.js バージョンを固定し、lockfile をコミットする
- テストは Workers と互換性のあるランナーを使い、D1を含むローカルテストを可能にする
- Discord API と LLM API はインターフェースを介して注入し、ビジネスロジックから直接 `fetch` しない
- 日時は保存時にUTCへ正規化し、LLMには現在日時、利用者のIANA timezone、元投稿時刻を明示する
- LLMの出力は信用せず、Worker側のschema検証を通過した値だけを保存・投稿する
- ログは構造化し、token、API key、生の会話全文、Interaction token、個人向けBriefを出力しない

採用ライブラリは実装開始時に保守状況と公式のWorkers対応を確認する。依存を増やす場合は「標準APIだけでは不足する理由」をPRへ記載する。

## 5. 想定するリポジトリ構成

最初の基盤PRで次の構成を作成する。実装中に変更する場合も、責務の境界は維持する。

```text
src/
  index.ts                  # Workerのfetch / scheduledエントリーポイント
  config.ts                 # Bindingsと非秘密設定の検証
  discord/
    signature.ts            # Interaction署名検証
    interactions.ts         # Interaction解析と応答
    client.ts               # Discord REST APIクライアント
  ai/
    client.ts               # LLM APIクライアント
    prompt.ts               # 入力コンテキスト構築
    schema.ts               # 構造化出力の検証
  domain/
    conversation.ts         # 履歴の組み立て
    brief.ts                # Brief更新判断の適用
    reminder.ts             # Scheduled Messageルール
  repositories/
    users.ts
    checkpoints.ts
    reminders.ts
    allowlist.ts
  handlers/
    interaction.ts
    scheduled.ts
migrations/
scripts/
  register-command.ts
test/
.devcontainer/
wrangler.jsonc
package.json
tsconfig.json
```

各モジュールと関数には、責務、入力、出力、失敗時の扱いが分かる日本語コメントを付ける。コードを逐語的に説明するコメントではなく、境界条件や設計理由を残す。

## 6. データモデル計画

`draft.md` の概念を次のテーブルへ具体化する。

### 6.1 `users`

- `discord_user_id`（主キー）
- `brief`
- `timezone`（IANA timezone。初期値は運用設定値）
- `brief_updated_at`

### 6.2 `channel_checkpoints`

- `guild_id` + `channel_id`（複合主キー）
- `last_ai_message_id`
- `updated_at`

前回AI参加位置だけを保持する。Discordを会話の原本とし、初期版では通常投稿をD1へ常時複製しない。`draft.md` の `messages` は、API取得結果の永続キャッシュが実測上必要になった場合に別PRで追加する。

### 6.3 `reminders`

- `id`（主キー）
- `created_by_user_id`
- `target_user_id`（チャンネル通知ならNULL）
- `guild_id`、`channel_id`
- `message`
- `remind_at`（UTC）
- `status`（`pending` / `processing` / `sent` / `failed` / `cancelled`）
- `attempt_count`、`next_attempt_at`、`lease_expires_at`
- `created_at`、`sent_at`、`last_error`

Cronの重複実行を前提に、取得しただけでは送信済みにしない。短いleaseで処理権を確保し、Discord投稿成功後に `sent` へ遷移する。失敗時は上限付きバックオフを適用し、恒久失敗を観測できるようにする。D1で実現可能な原子的更新方法は、着手時の公式仕様確認後に確定する。

### 6.4 allowlist

- `allowed_guilds(guild_id, enabled)`
- `allowed_users(user_id, enabled)`

すべての検索と更新でIDを文字列として扱い、Discord snowflake をJavaScriptの `number` に変換しない。

## 7. PR単位の実装フェーズ

各PRは前のPRがマージされた状態から作成する。大きな一括タスクをCodex Cloudへ渡さず、以下の順に独立した受入条件を持つタスクとして依頼する。

### Phase 0 — リポジトリ基盤と開発環境

**実装内容**

- TypeScript / Wrangler / test runner / lint / format / typecheck の導入
- `.devcontainer/devcontainer.json` と推奨VS Code拡張の追加
- `.gitignore` に `.dev.vars*`、`.env*`、Wranglerのローカル状態を追加
- `wrangler.jsonc` に binding名、Cron、Preview / Production の雛形を定義
- 最小の `fetch` / `scheduled` handler とヘルスチェックを作成
- CIで install、lint、typecheck、test を実行

**受入条件**

- Codespace作成後、README記載の1コマンドで依存関係を導入できる
- ローカルWorkerが起動し、ヘルスチェックへ応答する
- シークレットなしで全自動テストが成功する
- ProductionのIDや資格情報が設定ファイルに含まれない

### Phase 1 — D1 schema とRepository

**実装内容**

- `users`、`channel_checkpoints`、`reminders`、`allowed_guilds`、`allowed_users` のmigration
- Repository層と日時・snowflakeの型を実装
- allowlist、Brief、checkpoint、Reminder状態遷移のテスト
- ローカル / Preview / Production それぞれのmigration手順を文書化

**受入条件**

- 空DBへの全migrationとロールフォワードを再現できる
- Guild / Channel境界を越えたデータ取得をテストで拒否できる
- Reminderの不正な状態遷移をRepositoryが受け付けない

### Phase 2 — Discord Interaction の安全な入口

**実装内容**

- raw request body に対するEd25519署名とtimestamp検証
- PING応答、`/ai` の解析、Guild / User allowlist確認
- 許可後の即時deferと、拒否時のephemeral応答
- defer後の処理を `waitUntil()` へ登録する非同期実行境界
- Interaction responseを編集するDiscordクライアント
- `/ai` 登録スクリプト（開発はGuild command、本番方式は設定可能）

**重要な順序**

```text
HTTP受信
  → 署名検証
  → Interaction種別検証
  → Guild/User allowlist
  → defer
  → 後続処理
```

**受入条件**

- 改ざんbody、期限外timestamp、署名なしを401相当で拒否する
- 許可外Guild/UserではD1の許可確認以外の外部APIを呼ばない
- PINGとdeferがDiscord公式の時間制約に適合する
- ログに署名、Bot Token、Interaction tokenを出さない

### Phase 3 — 会話履歴とAI応答

**実装内容**

- checkpoint以降のChannel Messages取得（最大100件）
- Bot自身の過去応答、今回のcommand、通常投稿を時系列に正規化
- Guild / Channel一致の防御的検証
- User Brief、現在日時、timezone、会話、今回依頼からLLM入力を構築
- `response`、`brief_update | null`、`reminder_add | null` の構造化出力schema
- Discordの文字数、日時の妥当性、target、空文字をWorker側で検証
- 通常応答では `allowed_mentions.parse = []` を強制

**更新順序**

1. Discordから履歴を取得する
2. D1からBriefとcheckpointを取得する
3. LLMを1回呼ぶ
4. 出力全体を検証する
5. 必要ならBrief / ReminderをD1へ保存する
6. Discord応答を編集する
7. 成功した位置へcheckpointを進める

途中失敗時の再実行でReminderを二重作成しないよう、Interaction IDに基づく冪等キーを設ける。DB更新とDiscord応答の完全な分散transactionはできないため、各段階の再実行規則と回復手順をテスト・文書化する。

**受入条件**

- 別Guild / Channel の生会話がプロンプトへ混ざらない
- 履歴0件、初回呼び出し、上限100件、Discord API失敗を扱える
- LLMが不正JSON、過去日時、任意ユーザーtarget、過長文を返しても保存・送信しない
- `@everyone`、`@here`、LLMが生成したユーザーメンションが発火しない
- LLM失敗時にBrief、Reminder、checkpointを不整合に更新しない

### Phase 4 — Scheduled Message 管理とCron配信

**実装内容**

- `/ai` からの追加に加え、一覧・削除の最小管理操作を実装
- `scheduled()` で期限到来Reminderを上限件数ずつ取得
- lease、再試行、送信済み遷移、失敗記録を実装
- チャンネル通知ではメンションなし、本人向けだけ明示的なUser IDを `allowed_mentions.users` に設定
- 削除は物理削除ではなく `cancelled` 遷移として監査可能にする

**受入条件**

- Cronが同時実行されても同じReminderを通常は二重送信しない
- 投稿成功前に `sent` へならない
- 作成者本人以外をtargetにできない
- 一覧・削除は作成者かつ同じGuildのReminderだけを対象にする
- Discord一時障害は再試行し、恒久エラーは無限再試行しない

### Phase 5 — 統合、セキュリティ、運用性

**実装内容**

- Discord / LLM のモックサーバーを使ったInteractionから応答までの統合テスト
- abuse対策としてrequest size、履歴件数、応答文字数、タイムアウトを制限
- 外部APIごとのエラー分類と利用者向けの安全なエラーメッセージ
- request / interaction / reminder の相関IDを使った構造化ログ
- Preview環境用のスモークテスト手順、rollback手順、障害対応表
- README、`implementation.md`、`deployment.md` を実装に合わせて更新

**受入条件**

- lint、typecheck、unit、integration、migration検査がCIで成功する
- token / key / 会話全文 / Briefがログとテストsnapshotへ含まれない
- 旧Workerへのrollbackと、前方互換なDB migration方針が文書化されている
- 下記の受入シナリオをPreviewで実行できる

## 8. Codex Cloud へのタスク依頼方法

各Phaseの依頼には、曖昧な「全部実装して」ではなく、次を含める。

```text
目的:
対象範囲:
対象外:
参照する設計: draft.md / plan.md の該当節
先に確認する公式ドキュメント:
受入条件:
実行必須コマンド:
PR本文に記載するリスク:
```

Codex Cloud の各タスクでは次の作業規則を適用する。

1. 最初に `AGENTS.md`、`draft.md`、`plan.md` と関連コードを読む
2. 外部APIを扱う場合は公式ドキュメントの現行仕様を確認する
3. 変更前に既存テストを実行し、失敗があれば記録する
4. 実装と同時に成功系・拒否系・再実行系のテストを追加する
5. lint、typecheck、test、migration検査を実行する
6. `git diff` で秘密情報、不要な生成物、意図しない変更を確認する
7. 1つのPhaseに閉じたコミットを作成し、日本語のPR本文を作成する

人間のレビューでは、特に認証境界、tenant境界、メンション、日時解釈、冪等性、migrationを確認する。Codex Cloud のPRを自動でProductionへデプロイしない。

## 9. Codespaces セットアップ計画

### 9.1 初回準備

1. GitHubでCodespaceを作成する
2. ローカルVS Codeに GitHub Codespaces 拡張機能を導入する
3. VS Codeの「Connect to Codespace」から同じCodespaceを開く
4. `.devcontainer` で固定されたNode.js / Wrangler環境が構築されたことを確認する
5. package managerのimmutable / frozenモードで依存関係を導入する
6. lint、typecheck、testを実行する

### 9.2 シークレットの置き場所

| 値 | 開発時 | Preview / Production |
|---|---|---|
| Discord Bot Token / Public Key | Codespaces secret またはgitignore済み `.dev.vars` | `wrangler secret put` |
| LLM API Key | Codespaces secret またはgitignore済み `.dev.vars` | `wrangler secret put` |
| Cloudflare API Token | Codespaces secret | Codespaces secret（権限最小化） |
| Application ID、Guild ID | 非秘密の環境別設定 | Wranglerの環境別 `vars` |

Codespaces secretをリポジトリsecretとして登録する場合は、アクセス対象リポジトリを限定する。`.dev.vars.example` にはキー名だけを置き、値は置かない。シークレットをshell historyへ残しにくい投入手順を採用し、デバッグ出力で環境変数一覧を表示しない。

## 10. Preview から Production へのデプロイ手順

実際のコマンド名とオプションは Phase 0 で固定し、`package.json` のscriptを唯一の入口にする。以下は手順の順序を示す。

### 10.1 Preview

1. `main` の最新コミットとcleanなworking treeを確認する
2. lint、typecheck、unit、integrationをすべて実行する
3. Preview用D1を作成し、bindingを設定する
4. Preview用secretsをWrangler経由で登録する
5. migrationの適用予定を確認してからPreview D1へ適用する
6. WorkerをPreview環境へデプロイする
7. Preview用Discord ApplicationへInteraction Endpoint URLを設定する
8. 開発Guildへ `/ai` をGuild commandとして登録する
9. 受入シナリオとログの秘匿性を確認する

### 10.2 Production

1. Previewで検証したGit SHAを記録する
2. 同じSHAからProduction用のcheckを再実行する
3. D1の復旧方法とmigrationの前方互換性を確認する
4. Production D1へmigrationを適用する
5. Production secretsが存在することを値を表示せず確認する
6. WorkerをProductionへデプロイする
7. DiscordのProduction Endpointとcommand設定を確認する
8. allowlistを投入してから、許可済みUserでスモークテストする
9. Cron実行とReminder配信を確認する
10. デプロイSHA、migration、確認結果をリリース記録へ残す

ProductionデプロイはCodespaceから人間が明示的に実行する。Codex Cloud、PR、通常CIにはProduction用API Tokenを与えない。

## 11. エンドツーエンド受入シナリオ

### 11.1 基本会話

- 許可Userが `/ai 疲れたー` を実行し、defer後にメンションなしで返答される
- 通常会話を挟んだ次の `/ai` で、前回以降の同一Channelの文脈だけを参照する
- 残す価値のある情報だけBriefへ反映し、変化がなければ更新日時も不要に変更しない

### 11.2 日時補完

- 07:00の会話後に「明日も同じ時間に起こして」と依頼すると、利用者timezoneの翌日07:00として確認・保存される
- DST境界、存在しないローカル時刻、曖昧な日時は推測で登録せず確認を求める
- 過去日時は登録しない

### 11.3 通知先

- 「明日の7時にゴミ出しを教えて」はチャンネル投稿になり、メンションを発火しない
- 「明日の7時に私を起こして」は作成者本人だけをメンションする
- 他人への個別通知依頼は拒否または本人向けへ変更せず、未作成として説明する

### 11.4 Access Control / 分離

- 許可外Guild、許可外User、DM、改ざん署名を拒否する
- 同じUserでも別Guild / Channelの生履歴を混ぜない
- User BriefだけがUser単位で共有される
- 任意の `@everyone` / `@here` / `<@他人>` を入力・LLM出力に含めても通知しない

### 11.5 障害と再実行

- Discord履歴取得失敗、LLM timeout、不正な構造化出力、D1失敗で安全な応答を返す
- 同じInteractionの再処理でReminderを二重作成しない
- Cronの重複起動、Discord 429 / 5xx、Worker途中終了でも状態が回復可能である
- 送信済みReminderを再送しない

## 12. 初期版の対象外と後続候補

初期版では以下を実装しない。

- Discord Gateway、通常投稿への自動応答
- 100件を超える履歴の完全取得や自動要約
- Vector DB、Embedding、横断検索
- 他人への通知、高度な繰り返し予定、予定変更UI
- Web管理画面、一般公開、課金、多言語UI
- 自動Productionデプロイ

運用後に計測してから、履歴ページング、要約、Reminderのdead-letter運用、管理コマンド、CI/CDの承認付きデプロイを個別に検討する。

## 13. 完了の定義

次のすべてを満たした時点で初期版を完了とする。

- Phase 0〜5のPRがレビュー・マージ済み
- CIの全checkが成功
- Previewで全受入シナリオを確認済み
- Production D1 / secrets / allowlist / Cronが構成済み
- 指定した複数Guildで `/ai` とScheduled Messageが動作
- データ分離、署名検証、メンション抑止、冪等性のテストが存在
- Codespacesに新規接続した担当者が文書だけで検証・デプロイ可能
- rollback、キー失効・更新、障害調査の手順が文書化済み
- Git履歴、PR、CIログ、Workerログに秘密情報がないことを確認済み
