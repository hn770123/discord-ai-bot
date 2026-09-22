# `discord-hono` 採用検討

最終確認日: 2026-09-22

## 結論

**現時点では `discord-hono` へ移行しない。**

`discord-hono` は Cloudflare Workers 向けの軽量な Discord Bot フレームワークであり、署名検証、Interaction 種別ごとのルーティング、遅延応答、Webhook 応答、Cron を簡潔に記述できる。新規 Bot、複数コマンド、Component、Modal、Autocomplete を多用する Bot では有力な候補である。

一方、この Bot は公開 HTTP 経路がヘルスチェックと単一の `/ai` コマンドだけであり、既存実装が必要な境界制御をすでに明示的に実装・テストしている。移行しても削減できるコードは限定的で、後述する制御を独自に補う必要があるため、現状では依存追加と移行リスクに見合う効果がない。

## 調査したバージョンと状態

- npm の最新版は `0.22.1` で、公開日は 2026-09-02。
- GitHub リポジトリはアーカイブされておらず、2026-09-20 時点でも更新されている。
- ランタイム依存はなく、TypeScript 利用時は `discord-api-types >=0.38.0` が任意の peer dependency となる。
- npm 上の展開後サイズは約 166 KB で、Cloudflare Workers を対象としている。
- メジャーバージョン `1.0.0` 未満であり、公式ドキュメントには破壊的変更向けの移行ガイドが用意されている。導入時は完全固定したバージョンで評価する必要がある。

## この Bot で採用する利点

1. `.command('ai', handler)` により Interaction の振り分けを宣言的に書ける。
2. `resDefer()` が初期 ACK と `ExecutionContext.waitUntil()` をまとめ、`followup()` が元の Interaction 応答の更新を隠蔽する。
3. Command builder と登録ヘルパーを使えば、コマンド定義と登録処理の重複を減らせる余地がある。
4. Component、Modal、Autocomplete を追加するとき、同じフレームワーク内で型付きハンドラーを増やせる。
5. Cron ハンドラーも提供されるため、小規模な Worker ならエントリーポイントを短くできる。

## 現時点で採用しない理由

### 1. ルーティング簡略化の効果が小さい

現在の Worker は `GET /health`、`POST /interactions`、Cron だけを扱う。Discord コマンドも `/ai` のみで、その内部操作は既存のドメイン値へ変換して分岐している。多数の Interaction ハンドラーを登録するフレームワークの主な利点をまだ活かせない。

### 2. 既存の防御的な境界処理を置き換えられない

現行コードは次の制約を明示している。

- `Content-Length` と実際の本文をそれぞれ 64 KiB に制限する。
- 署名だけでなく timestamp が現在時刻から 5 分以内であることも検証する。
- JSON を `unknown` から解析し、Guild、Member、Snowflake、option の型・長さ・組み合わせを検証する。
- allowlist の確認後にだけ処理を開始する。
- すべての JSON 応答へ `Cache-Control: no-store` を付ける。
- 外部 API の失敗を分類し、秘密値や本文をログへ残さず固定メッセージへ変換する。

`discord-hono` 0.22.1 の標準 `fetch` は本文を文字列として読み、Ed25519 署名を検証してから `JSON.parse` するが、本文サイズや timestamp の鮮度は標準では制限しない。また、標準レスポンスへ `no-store` を一律付与する機構でもない。カスタム `verify` は渡せるものの、本文サイズの確認は標準 `fetch` が本文全体を読み込んだ後になるため、現在と同じ境界を保つには外側のラッパーが必要になる。

### 3. 型付けだけでは実行時検証を代替できない

`discord-api-types` による型推論や command builder は開発時には便利だが、ネットワークから届く JSON の実行時検証にはならない。この Bot が行う option 長、重複 option、操作ごとの禁止 option などの検証は移行後も維持する必要がある。

### 4. 応答クライアントと登録処理が二重化しやすい

この Bot の Discord クライアントはタイムアウト、再試行、`allowed_mentions`、安全なエラー分類を共通化している。`discord-hono` の `c.rest`、`followup()`、登録ヘルパーへ部分移行すると、同じ外部 API に対する方針が二系統になりやすい。全面移行するには既存の信頼性要件を満たすか個別に検証し直す必要がある。

### 5. 移行に対して回帰範囲が広い

Interaction の認証、PING、400/401/413、権限拒否、defer、バックグラウンド処理、失敗時の元応答編集、Cron のすべてが Worker の入口に接続されている。フレームワーク導入は単なるルーター交換ではなく、これらの契約とテスト fixture の移植になる。

## 判断表

| 観点                  | 現行実装               | `discord-hono` 導入後        | 判断       |
| --------------------- | ---------------------- | ---------------------------- | ---------- |
| 単一コマンドの可読性  | すでに責務分離済み     | エントリーポイントは短くなる | 小さな利点 |
| 署名検証              | 署名、時刻、形式を制御 | 署名は標準、時刻は追加実装   | 現行が適合 |
| 本文サイズ制限        | 読み込み前後で検査     | 外側の処理が必要             | 現行が適合 |
| 実行時入力検証        | 独自要件を網羅         | 別途維持が必要               | 差なし     |
| defer と応答更新      | 実装済み               | API が簡潔                   | 小さな利点 |
| REST の再試行・安全性 | Bot 全体で統一         | 要件を再検証・補完           | 現行が適合 |
| Component/Modal 拡張  | 新規実装が必要         | 組み込み対応                 | 将来の利点 |
| 依存と更新対応        | 直接利用する API のみ  | 0.x の追従が増える           | 現行が単純 |

## 再検討する条件

次のいずれかが発生した時点で、限定的な試作を行って再評価する。

1. 独立した Slash Command が 3 個以上に増える。
2. Button、Select、Modal、Autocomplete を本格的に導入する。
3. コマンド定義と Interaction の型を単一ソースから生成する必要が生じる。
4. `discord-hono` が 1.x へ安定し、timestamp 鮮度、本文上限、共通レスポンスヘッダーを公式に構成できる。
5. 現行の Interaction 境界コードの保守コストが、フレームワーク追従コストを明確に上回る。

## 再検討時の検証項目

- `discord-hono` のバージョンを完全固定し、リリースノートと移行ガイドを確認する。
- 現在の Interaction テストを変更前後で共通実行し、署名、timestamp、本文上限、PING、allowlist、defer の振る舞いを比較する。
- `c.rest` の timeout、429、5xx、`allowed_mentions` の既定値を確認する。
- `resDefer()` 内の `waitUntil()` が現在の失敗ログとエラー応答を保持できるよう統合する。
- Worker bundle サイズと cold start を計測し、コード行数だけで採否を決めない。
- `/health` のレスポンス形式と `Cache-Control`、未知のパスの 404 を維持する。

## 参照資料

- [`discord-hono` 公式リポジトリ](https://github.com/luisfun/discord-hono)
- [`discord-hono` npm パッケージ](https://www.npmjs.com/package/discord-hono)
- [`discord-hono` 公式ドキュメント](https://discord-hono.luis.fun/)
- [`DiscordHono` 実装](https://github.com/luisfun/discord-hono/blob/main/src/discord-hono.ts)
- [署名検証の実装](https://github.com/luisfun/discord-hono/blob/main/src/verify.ts)
- [Context と遅延応答の実装](https://github.com/luisfun/discord-hono/blob/main/src/context.ts)
- [Discord: Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Cloudflare Workers: `waitUntil()`](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
