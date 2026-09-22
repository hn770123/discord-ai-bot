## 🔥 現在の最強構成：Hono + discord-hono
もし今からCloudflare Workersでスラッシュコマンド専用Botを作るなら、discord-interactions を単体で使うよりも、日本発の超軽量Webフレームワーク [Hono（ホノ）](https://blog.lacolaco.net/posts/discord-bot-cfworkers-hono) と、その周辺エコシステムを使うのが圧倒的にトレンドであり、開発が何倍も楽になります。 [1] 
最近では、Workers上でDiscord Botを動かすことに特化した discord-hono という、署名検証から3秒ルールの回避（Defer）までをすべて綺麗にラップしてくれているライブラリが登場し、大人気になっています。 [7, 8] 
## 💡 Hono 構成が選ばれる理由

* 
* めんどくさい署名検証を自動でやってくれる
* スラッシュコマンドごとのルーティング（/hello が来たらこの関数を実行、など）が、WebAPIを書く感覚でめちゃくちゃ綺麗に書ける
* Cloudflare Workersの無料データベース（KVやD1など）との連携が非常にスムーズ [1, 8] 
* 
