import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 実際の Workers ランタイム上でテストし、Node.js 固有 API への偶発的な依存を防ぐ。
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
      },
    },
  },
});
