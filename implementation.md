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
SELECT * FROM reminders
WHERE remind_at <= ? AND status = 'pending'
ORDER BY remind_at
LIMIT 100;
```

送信後は `sent` にする。重複送信対策として `status` と `sent_at` を持つ。

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
