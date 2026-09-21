/**
 * `/ai` の履歴取得から永続化、Discord応答、checkpoint更新までを規定順序で調停する。
 * 外部クライアントを注入し、単体テストではネットワークへ接続しない。
 */
import { buildAiPrompt } from '../ai/prompt';
import type { AiClient } from '../ai/client';
import type { DiscordClient } from '../discord/client';
import type { AiInteraction } from '../discord/interactions';
import { normalizeConversation } from '../domain/conversation';
import { toUtcDateTime } from '../domain/types';
import { CheckpointsRepository } from '../repositories/checkpoints';
import { RemindersRepository } from '../repositories/reminders';
import { UsersRepository } from '../repositories/users';

export interface AiWorkflowDependencies {
  db: D1Database;
  discord: DiscordClient;
  ai: AiClient;
  defaultTimezone: string;
  now?: () => Date;
}

/**
 * 構造化出力全体の検証完了後にだけDBを書き換える。
 * Reminder IDにはInteraction IDを使い、同一Interactionの再実行を重複登録しない。
 */
export async function processAiInteraction(
  interaction: AiInteraction,
  dependencies: AiWorkflowDependencies,
): Promise<void> {
  const checkpoints = new CheckpointsRepository(dependencies.db);
  const users = new UsersRepository(dependencies.db);
  const reminders = new RemindersRepository(dependencies.db);
  const now = dependencies.now?.() ?? new Date();

  const checkpoint = await checkpoints.find(interaction.guildId, interaction.channelId);
  const rawMessages = await dependencies.discord.listChannelMessages({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    ...(checkpoint === null ? {} : { after: checkpoint.lastAiMessageId }),
  });
  const conversation = normalizeConversation(
    rawMessages,
    interaction.guildId,
    interaction.channelId,
  );

  await users.ensureUser(interaction.userId, dependencies.defaultTimezone);
  const user = await users.findById(interaction.userId);
  if (user === null) throw new Error('User initialization failed');

  const result = await dependencies.ai.generate(
    buildAiPrompt({
      now,
      timezone: user.timezone,
      brief: user.brief,
      conversation,
      request: interaction.prompt,
    }),
    now,
  );

  const updatedAt = toUtcDateTime(now);
  if (result.briefUpdate !== null && result.briefUpdate !== user.brief) {
    await users.updateBrief(interaction.userId, result.briefUpdate, updatedAt);
  }
  if (result.reminderAdd !== null) {
    await reminders.create({
      id: interaction.interactionId,
      createdByUserId: interaction.userId,
      targetUserId: result.reminderAdd.target === 'user' ? interaction.userId : null,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      message: result.reminderAdd.message,
      remindAt: result.reminderAdd.at,
      createdAt: updatedAt,
    });
  }

  const responseMessageId = await dependencies.discord.editOriginalInteractionResponse({
    applicationId: interaction.applicationId,
    interactionToken: interaction.interactionToken,
    content: result.response,
  });
  await checkpoints.save({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    lastAiMessageId: responseMessageId,
    updatedAt,
  });
}
