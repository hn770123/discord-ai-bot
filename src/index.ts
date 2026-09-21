/**
 * Cloudflare Worker のエントリーポイント。
 * HTTP と Cron の境界だけを公開し、後続フェーズの Discord／D1 処理をここへ集約しない。
 */

/** ヘルスチェックで返す固定レスポンス。秘密情報や環境固有値は含めない。 */
const HEALTH_RESPONSE = Object.freeze({ status: 'ok' });

/**
 * HTTP リクエストを処理する。
 * 現段階では GET /health のみを公開し、それ以外は情報を漏らさず 404 を返す。
 */
function handleFetch(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json(HEALTH_RESPONSE, {
      headers: { 'cache-control': 'no-store' },
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
  fetch(request: Request): Response {
    return handleFetch(request);
  },
  scheduled(controller: ScheduledController): void {
    // controller は後続 Phase で実行時刻や Cron 式の参照に使用する。
    void controller;
    handleScheduled();
  },
} satisfies ExportedHandler<Env>;
