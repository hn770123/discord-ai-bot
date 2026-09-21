// Wrangler の型生成を導入するまで、Phase 0 で使用する Binding の契約を一か所に置く。
interface Env {
  DB: D1Database;
  ENVIRONMENT: 'local' | 'preview' | 'production';
}
