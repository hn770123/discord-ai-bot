// Wrangler の型生成を導入するまで、Phase 0 で使用する Binding の契約を一か所に置く。
interface Env {
  DB: D1Database;
  ENVIRONMENT: 'local' | 'preview' | 'production';
  /** Discord署名検証用の公開鍵。Bot Tokenとは異なり、受信リクエストの認証だけに使う。 */
  DISCORD_PUBLIC_KEY: string;
  /** Channel Messages API の Bot 認証に使うSecret。 */
  DISCORD_BOT_TOKEN: string;
  /** OpenAI Responses API の認証に使うSecret。 */
  OPENAI_API_KEY: string;
  /** Structured Outputs 対応モデル名。環境ごとに明示する。 */
  OPENAI_MODEL: string;
  /** 初回Userへ設定する IANA timezone。 */
  DEFAULT_TIMEZONE: string;
  /** Vitestだけが注入するmigration。デプロイ環境では参照しない。 */
  TEST_MIGRATIONS?: import('cloudflare:test').D1Migration[];
}

// cloudflare:test の env proxy にWorker bindingの型を伝え、実DBと同じ契約でテストする。
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
