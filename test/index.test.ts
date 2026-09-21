/**
 * Worker エントリーポイントの契約テスト。
 * 外部サービスやシークレットなしで HTTP と Cron の最小境界を検証する。
 */
import { SELF, createScheduledController } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker', () => {
  /** 正常性監視が利用する JSON とキャッシュ方針を確認する。 */
  it('responds to GET /health', async () => {
    const response = await SELF.fetch('https://worker.example/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  /** 未定義ルートを成功扱いせず、固定の 404 応答にする。 */
  it('returns 404 for an unknown route', async () => {
    const response = await SELF.fetch('https://worker.example/unknown');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not Found' });
  });

  /** Cron ハンドラーが秘密情報や外部サービスなしで完了することを確認する。 */
  it('handles a scheduled event', async () => {
    const worker = await import('../src/index');
    const controller = createScheduledController({ cron: '* * * * *' });

    expect(() => worker.default.scheduled(controller)).not.toThrow();
  });
});
