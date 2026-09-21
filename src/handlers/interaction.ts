/**
 * Discord Interaction の認証、解析、認可、初期応答を規定順序で実行する HTTP ハンドラー。
 * defer 後の仕事は ExecutionContext へ登録し、レスポンス返却後も処理を継続させる。
 */
import { AllowlistRepository } from '../repositories/allowlist';
import type { DiscordClient } from '../discord/client';
import {
  EPHEMERAL_MESSAGE_FLAG,
  getInteractionType,
  INTERACTION_TYPE_PING,
  InvalidInteractionError,
  parseAiInteraction,
  RESPONSE_TYPE_CHANNEL_MESSAGE,
  RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE,
  RESPONSE_TYPE_PONG,
  type AiInteraction,
} from '../discord/interactions';
import { verifyDiscordSignature } from '../discord/signature';

export interface InteractionHandlerDependencies {
  db: D1Database;
  publicKey: string;
  discord: DiscordClient;
  context: Pick<ExecutionContext, 'waitUntil'>;
  now?: Date;
  processAi?: (interaction: AiInteraction) => Promise<string>;
  executeAi?: (interaction: AiInteraction) => Promise<void>;
}

/** 認可後かつ defer 後にだけ実行する、Phase 3 までの安全な暫定処理。 */
function defaultProcessAi(): Promise<string> {
  return Promise.resolve('AI応答機能は現在準備中です。');
}

/** POST /interactions を処理し、認証失敗の詳細を外部へ開示しない。 */
export async function handleInteraction(
  request: Request,
  dependencies: InteractionHandlerDependencies,
): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifyDiscordSignature({
    publicKey: dependencies.publicKey,
    signature: request.headers.get('x-signature-ed25519'),
    timestamp: request.headers.get('x-signature-timestamp'),
    rawBody,
    now: dependencies.now,
  });
  if (!verified) return json({ error: 'Unauthorized' }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
    if (getInteractionType(payload) === INTERACTION_TYPE_PING) {
      return json({ type: RESPONSE_TYPE_PONG });
    }

    const interaction = parseAiInteraction(payload);
    const allowed = await new AllowlistRepository(dependencies.db).isAllowed(
      interaction.guildId,
      interaction.userId,
    );
    if (!allowed) {
      return json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: 'このコマンドを利用する権限がありません。',
          flags: EPHEMERAL_MESSAGE_FLAG,
        },
      });
    }

    const processing =
      dependencies.executeAi?.(interaction) ??
      processDeferredInteraction(
        interaction,
        dependencies.discord,
        dependencies.processAi ?? defaultProcessAi,
      );
    dependencies.context.waitUntil(processing);
    return json({ type: RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE });
  } catch (error) {
    if (error instanceof InvalidInteractionError || error instanceof SyntaxError) {
      return json({ error: 'Bad Request' }, 400);
    }
    throw error;
  }
}

/** AI処理結果で元レスポンスを編集する。token や本文はログへ出さず、失敗は waitUntil 側へ伝播する。 */
async function processDeferredInteraction(
  interaction: AiInteraction,
  discord: DiscordClient,
  processAi: (interaction: AiInteraction) => Promise<string>,
): Promise<void> {
  const content = await processAi(interaction);
  await discord.editOriginalInteractionResponse({
    applicationId: interaction.applicationId,
    interactionToken: interaction.interactionToken,
    content,
  });
}

/** Discord向けJSON応答へ no-store を付与し、Interaction情報のキャッシュを防ぐ。 */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
