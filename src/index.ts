/** Cloudflare Worker のエントリーポイント。HTTP と Cron の境界だけを公開する。 */
import { createDiscordClient } from './discord/client';
import { handleInteraction } from './handlers/interaction';

/** ヘルスチェックで返す固定レスポンス。秘密情報や環境固有値は含めない。 */
const HEALTH_RESPONSE = Object.freeze({ status: 'ok' });

/**
 * HTTP リクエストを処理する。
 * GET /health と署名検証付き POST /interactions だけを公開し、それ以外は404を返す。
 */
async function handleFetch(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json(HEALTH_RESPONSE, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'POST' && url.pathname === '/interactions') {
    return handleInteraction(request, {
      db: env.DB,
      publicKey: env.DISCORD_PUBLIC_KEY,
      discord: createDiscordClient(),
      context,
    });
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

/**
 * Cron Trigger を受け取る最小ハンドラー。
 * Reminder 配信は後続フェーズで実装するため、現時点では副作用を発生させない。
 */
function handleScheduled(): void {
  // Phase 0 ではハンドラーが正常に呼び出せることだけを保証する。
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, context);
  },
  scheduled(controller: ScheduledController): void {
    // controller は後続 Phase で実行時刻や Cron 式の参照に使用する。
    void controller;
    handleScheduled();
  },
} satisfies ExportedHandler<Env>;
