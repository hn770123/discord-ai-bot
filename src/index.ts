/** Cloudflare Worker のエントリーポイント。HTTP と Cron の境界だけを公開する。 */
import { createDiscordClient } from './discord/client';
import { createOpenAiClient } from './ai/client';
import { processAiInteraction } from './handlers/ai';
import { handleInteraction } from './handlers/interaction';
import { processReminderManagement } from './handlers/reminder-management';
import { processScheduledReminders } from './handlers/scheduled';

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
        (interaction.operation === 'chat'
          ? processAiInteraction(interaction, {
              db: env.DB,
              discord,
              ai,
              defaultTimezone: env.DEFAULT_TIMEZONE,
            })
          : processReminderManagement(interaction, { db: env.DB, discord })
        ).catch(async () => {
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
 * Cron Trigger の実行時刻を基準に、期限到来Reminderを上限件数ずつ配信する。
 */
function handleScheduled(env: Env, scheduledTime: number): Promise<void> {
  return processScheduledReminders({
    db: env.DB,
    discord: createDiscordClient(env.DISCORD_BOT_TOKEN),
    now: () => new Date(scheduledTime),
  });
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, context);
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(handleScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
