import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// 本番と同じSQLファイルをテストへ渡し、テスト専用スキーマとの乖離を防ぐ。
const migrations = await readD1Migrations('./migrations');

// 実際の Workers ランタイム上でテストし、Node.js 固有 API への偶発的な依存を防ぐ。
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      },
    },
  },
});
