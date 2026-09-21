/** `/ai` の一覧・削除操作を、作成者とGuildの認可境界内で処理する。 */
import type { DiscordClient } from '../discord/client';
import type { AiInteraction } from '../discord/interactions';
import { RemindersRepository, type Reminder } from '../repositories/reminders';

export interface ReminderManagementDependencies {
  db: D1Database;
  discord: DiscordClient;
}

/** 管理結果をdefer済みInteractionへ返し、AIや会話履歴APIは呼び出さない。 */
export async function processReminderManagement(
  interaction: AiInteraction,
  dependencies: ReminderManagementDependencies,
): Promise<void> {
  const repository = new RemindersRepository(dependencies.db);
  let content: string;
  if (interaction.operation === 'list') {
    const reminders = await repository.listForCreatorInGuild(
      interaction.userId,
      interaction.guildId,
    );
    content = formatReminderList(reminders);
  } else if (interaction.operation === 'cancel' && interaction.reminderId !== null) {
    const cancelled = await repository.cancelForCreatorInGuild(
      interaction.reminderId,
      interaction.userId,
      interaction.guildId,
    );
    content = cancelled
      ? `予定 ${interaction.reminderId} をキャンセルしました。`
      : '対象の予定が見つからないか、キャンセルできる状態ではありません。';
  } else {
    throw new TypeError('Reminder management operation is required');
  }
  await dependencies.discord.editOriginalInteractionResponse({
    applicationId: interaction.applicationId,
    interactionToken: interaction.interactionToken,
    content,
  });
}

/** Discordの2000文字上限を越えない件数・本文長で監査可能な状態も表示する。 */
function formatReminderList(reminders: Reminder[]): string {
  if (reminders.length === 0) return '登録されている予定はありません。';
  const lines = reminders.map((reminder) => {
    const message = reminder.message.replace(/\s+/g, ' ').slice(0, 50);
    return `• ${reminder.id} | ${reminder.remindAt} | ${reminder.status} | ${message}`;
  });
  return `予定一覧（最大20件）\n${lines.join('\n')}`.slice(0, 2000);
}
