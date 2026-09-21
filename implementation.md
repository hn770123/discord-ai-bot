# Discord AI Bot — Implementation Notes

## 1. 実装方針
このBotは Discord Gateway 常時接続型ではなく、HTTP Interaction 中心で実装する。

```text
/ai Interaction
    → Worker fetch()
    → Discord署名検証
    → defer
    → 会話履歴取得
    → D1取得
    → LLM
    → D1更新
    → Interaction応答更新

Cron Trigger
    → Worker scheduled()
    → 期限到来Scheduled Message検索
    → Discord REST APIで投稿
```

## 2. Discord Interaction
Discord Developer Portal で Interactions Endpoint URL に Worker のURLを設定する。
Discordから届くHTTPリクエストは必ず署名検証する。

署名は JSON parse 前の raw body に対して検証し、`X-Signature-Ed25519` と `X-Signature-Timestamp` の欠落・形式不正を同じ401応答で拒否する。リプレイ対策として、Worker時刻との差が5分を超える timestamp も拒否する。

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
```

- `APPLICATION_ID`: コマンド登録等
- `PUBLIC_KEY`: Discord → Worker の署名検証
- `BOT_TOKEN`: Worker → Discord REST API の認証

`BOT_TOKEN` は Worker Secret に保存する。

## 3. 応答が遅い場合
Discord Interaction は初期応答を3秒以内に返す必要があるため、`/ai` は原則すべて defer する。

最初に:
```json
{"type": 5}
```

その後、履歴取得 → D1取得 → LLM → DB更新 → 元のInteraction Response編集、の順で処理する。

拒否時は `flags: 64` の ephemeral message を返す。許可時は `type: 5` を返す前に後続 Promise を `ExecutionContext.waitUntil()` へ登録し、元応答は `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original` で編集する。

## 4. 会話履歴取得
Gatewayで常時監視しない。`/ai` が呼ばれた時点で Channel Messages API を使う。

```http
GET /api/v10/channels/{channel_id}/messages?after={last_message_id}&limit=100
Authorization: Bot {DISCORD_BOT_TOKEN}
```

`last_message_id` は前回AIが参加した位置としてD1に保持する。
初期版では履歴が100件を超えるケースを過剰設計しない。必要になってからページング・要約・検索を追加する。

API応答は未信頼入力として扱い、各Messageの `guild_id` と `channel_id` がInteractionと一致する場合だけ採用する。Discord APIが通常返す新しい順の配列は投稿時刻とsnowflakeで古い順へ正規化し、空本文は除外する。checkpointがない初回も `limit=100` とし、取得結果が0件でも今回の `/ai` 依頼だけで処理を継続する。

## 5. Message Content / 権限
必要権限:

```text
View Channels
Read Message History
Send Messages
```

通常メッセージ本文を取得できるか、Developer Portal の Message Content 関連設定と実APIレスポンスを確認する。
権限は可能な限り対象チャンネルだけに絞る。

## 6. LLM入力
原則1回の `/ai` で1回だけLLMを呼ぶ。

```text
System Instruction
Current Date/Timezone
User Brief
Conversation since last AI participation
Current /ai request
Existing reminders if needed
```

出力例:
```json
{
  "response": "了解。明日も7時に声かけるね。",
  "brief_update": null,
  "reminder_add": {
    "at": "2026-09-22T07:00:00+09:00",
    "message": "起きる時間だよ",
    "target": "user"
  }
}
```

`target = channel` はメンションなし、`target = user` は作成者本人へのメンション。
LLM出力はWorker側で日時・target・文字数等を検証する。

OpenAI Responses API の `text.format` に strict JSON Schema を指定する。モデルがschemaへ適合させた場合も信用せず、Workerで未知プロパティ、空文字、Discordの2000文字上限、無効／過去日時、`channel`／`user` 以外のtargetを再検証する。`user` はInteractionを実行した本人へ固定し、任意User IDをモデルから受け取らない。

## 7. Mention制御
Discord投稿時は `allowed_mentions` を明示する。

チャンネル通知:
```json
{"content":"ゴミ出しの時間だよ","allowed_mentions":{"parse":[]}}
```

個人通知:
```json
{"content":"<@USER_ID> 起きる時間だよ","allowed_mentions":{"users":["USER_ID"]}}
```

LLM生成文中の `@everyone`、`@here`、任意ユーザーへの意図しないメンションを発火させない。

## 8. Access Control
```text
署名検証
  ↓
guild_id allowlist
  ↓
user_id allowlist
  ↓
channel access check
  ↓
AI処理
```

拒否時はLLMを呼ばない。
会話履歴の検索条件には必ず `guild_id` と `channel_id` を含め、別Guild/Channelの生ログを混ぜない。
User BriefだけはDiscord User単位で共有可能。

## 9. Scheduled Message
Cloudflare Cron Trigger で期限到来分を処理する。

```sql
SELECT id FROM reminders
WHERE (status = 'pending' AND next_attempt_at <= ?)
   OR (status = 'processing' AND lease_expires_at <= ?)
ORDER BY next_attempt_at
LIMIT 100;
```

候補取得後、同じ期限条件を持つ `UPDATE` で60秒のleaseを獲得する。並行Cronが同じ候補を読んでも、条件付き更新の `meta.changes = 1` を得た実行だけが投稿する。Discord投稿成功後にだけ `sent` にし、投稿前に送信済みとは扱わない。Workerが投稿成功直後かつDB更新前に停止した場合はlease切れ後の再送余地があるため、外部APIを含む完全なexactly-onceではなく通常時の重複抑止として扱う。

HTTP 408、429、5xxと通信例外は指数バックオフで `pending` へ戻し、最大5回で `failed` にする。それ以外の4xxは恒久エラーとして初回で `failed` にする。`last_error` にはレスポンス本文やtokenを保存せず、状態コードの分類だけを記録する。

管理操作は `/ai action:list` と `/ai action:cancel reminder_id:<ID>` で提供する。一覧とキャンセルのSQLはどちらも `created_by_user_id` と `guild_id` を必須条件とし、キャンセルは物理削除せず `pending` から `cancelled` へ遷移する。本人向けReminderの `target_user_id` は作成者本人だけをRepositoryでも許可する。

チャンネル通知は `allowed_mentions: { parse: [] }`、本人向け通知は本文先頭へ `<@USER_ID>` を付け、`allowed_mentions: { parse: [], users: [USER_ID] }` を送る。Reminder本文内の他のmentionは通知されない。

## 10. D1の役割
主に保持するもの:
- User Brief
- 前回AI参加位置
- 必要なRecent Message
- Scheduled Message
- allowlist

Discord上の会話を原本と考える。

## 11. エラー処理
最低限区別する。

```text
Discord署名不正
Discord REST API失敗
LLM API失敗
D1失敗
Scheduled Message送信失敗
許可外Guild/User
```

LLM失敗時にBriefやReminderを中途半端に更新しない。

更新順序は「履歴 → checkpoint／User → LLM 1回 → 出力全体の検証 → Brief／Reminder → Discord応答 → checkpoint」とする。Reminderの主キーにはInteraction IDを使用し、再実行時のINSERTは `ON CONFLICT DO NOTHING` とする。LLM失敗時はUserの初期行以外を変更しない。Discord編集失敗時はcheckpointを進めないため履歴を失わず、再実行時のReminderは同じ主キーで重複しない。Discord成功後のcheckpoint保存失敗では次回履歴に直前のBot応答が再び含まれる可能性があるため、運用ではD1障害の解消後に再実行し、必要なら対象Channelのcheckpointを成功したBot Message IDへ修復する。

## 12. 参考
Discord:
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/resources/message
- https://docs.discord.com/developers/quick-start/getting-started

Cloudflare:
- https://developers.cloudflare.com/workers/
- https://developers.cloudflare.com/workers/runtime-apis/context/
- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/

OpenAI:
- https://developers.openai.com/api/reference/resources/responses/methods/create
- https://developers.openai.com/api/docs/guides/structured-outputs
