/** Cloudflare Worker のエントリーポイント。HTTP と Cron の境界だけを公開する。 */
import { createDiscordClient } from './discord/client';
import { createOpenAiClient } from './ai/client';
import { processAiInteraction } from './handlers/ai';
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
    const discord = createDiscordClient(env.DISCORD_BOT_TOKEN);
    const ai = createOpenAiClient(env.OPENAI_API_KEY, env.OPENAI_MODEL);
    return handleInteraction(request, {
      db: env.DB,
      publicKey: env.DISCORD_PUBLIC_KEY,
      discord,
      context,
      executeAi: (interaction) =>
        processAiInteraction(interaction, {
          db: env.DB,
          discord,
          ai,
          defaultTimezone: env.DEFAULT_TIMEZONE,
        }).catch(async () => {
          // 外部APIや検証の詳細を漏らさず、可能な場合だけdefer済み応答を安全な文面へ置き換える。
          await discord.editOriginalInteractionResponse({
            applicationId: interaction.applicationId,
            interactionToken: interaction.interactionToken,
            content: '処理中に問題が発生しました。時間をおいてもう一度お試しください。',
          });
        }),
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
