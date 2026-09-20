# Discord AI Bot — Draft v3

## 概要
Cloudflare Workers 上で動く、小規模な家族向け Discord AI Bot。
万能AIではなく「話す・覚えている・あとで声をかける」に絞り、人間同士の会話を主役にする。

## 基本UI
AIを呼ぶときだけ `/ai` を使う。通常投稿にはAIは自動応答しない。

```text
/ai 疲れたー
/ai 明日も同じ時間に起こして
```

## 会話履歴
Discord Gateway の常時接続は使わない。

`/ai` が呼ばれたとき、Worker が Discord REST API から対象チャンネルの「前回のAI参加以降」の投稿を取得する。

```text
普段の会話 → Discord
                 ↓
               /ai
                 ↓
              Worker
                 ↓
      REST APIで会話履歴取得
                 ↓
 Brief + 履歴 + 今回の発言 → LLM
```

静かな小規模チャンネルを想定するため、巨大な履歴への対応は初期版では行わない。必要になってから検索・要約を追加する。

## User Brief
Brief は完全な記憶ではなく、雑談用の短い引き継ぎメモ。

`/ai` のタイミングで、それまでの会話と現在の Brief をLLMへ渡し、残す価値のある変化がある場合だけ更新する。なければ更新しない。

会話の原記録と Brief は別物として扱う。

## Scheduled Message / Reminder
内部的には「Reminder」よりも「未来のDiscord投稿」として扱う。

```text
07:00 /ai おはよう。起きたよ
07:02 /ai 明日も同じ時間に起こして
      → 明日 07:00 に投稿
```

「同じ時間」のような省略を、会話履歴・投稿時刻・Briefから補完できることを重視する。

### 通知先
初期ルール:

- 通常の `/ai` 応答はメンションしない
- Scheduled Message は原則、そのチャンネルへ投稿する
- 「私に教えて」「起こして」など明確に個人向けなら本人へメンションする
- 他人への個別通知は初期版では扱わない

例:

```text
/ai 明日の7時にゴミ出しを教えて
→ ゴミ出しの時間だよ

/ai 明日の7時に私を起こして
→ @Hiro 起きる時間だよ
```

管理機能は「追加・一覧・削除」のみ。変更は「削除 + 再作成」で扱う。
期限到来の投稿は Cloudflare Cron Trigger から実行する。

## Access Control
Worker自体はインターネットから到達可能だが、利用できるDiscord環境を制限する。

最低限:
- Discord Interaction の署名検証
- 許可した Guild のみ利用可能
- 許可した User のみ利用可能
- Bot Token / LLM API Key は Worker Secrets に保存
- 会話履歴は Guild / Channel 境界を越えて参照しない

家族サーバーと、家族メンバー個人のサーバーなど複数Guildで利用できる構成を想定する。
User Brief はユーザー単位で共有してよいが、生の会話履歴はサーバー・チャンネルごとに分離する。

## D1
```text
users
  discord_user_id
  brief
  brief_updated_at

messages
  message_id
  guild_id
  channel_id
  user_id
  content
  created_at

reminders
  id
  created_by_user_id
  target_user_id nullable
  guild_id
  channel_id
  message
  remind_at
  created_at

allowed_guilds
  guild_id
  enabled

allowed_users
  user_id
  enabled
```

`target_user_id = null` ならチャンネル通知、値があれば個人メンション付き通知とする。

## 構成
```text
Discord /ai
    ↓
Cloudflare Worker
    ├─ Discord署名検証
    ├─ Guild/User許可チェック
    ├─ Discord REST API → 前回以降の会話
    ├─ D1 → Brief / Scheduled Message
    ↓
LLM
    ├─ response
    ├─ brief_update or null
    └─ reminder_add or null
    ↓
Worker → Discord

Cloudflare Cron
    └─ 期限到来 Scheduled Message → Discord
```

## 初期版でやらないこと
- Discord Gateway の常時接続
- Vector DB / Embedding検索 / 大規模RAG
- 会話履歴の常時LLM処理
- 高機能なReminder管理
- 他人への自由な通知
- 本格的なTODO・カレンダー
- 万能AIアシスタント化

## 体験の中心
人間同士は普通にDiscordで話す。AIが必要になったら `/ai` で呼ぶ。AIはそれまでの会話を読んでから参加し、必要ならその文脈から未来のDiscord投稿も作る。
