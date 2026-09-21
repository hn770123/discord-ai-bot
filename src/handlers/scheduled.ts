/** Reminder のlease獲得、Discord投稿、成功・再試行・恒久失敗の状態遷移を調停する。 */
import { DiscordApiError, type DiscordClient } from '../discord/client';
import { toUtcDateTime } from '../domain/types';
import { RemindersRepository, type Reminder } from '../repositories/reminders';

export const REMINDER_BATCH_SIZE = 100;
export const REMINDER_MAX_ATTEMPTS = 5;
const LEASE_MILLISECONDS = 60_000;
const MAX_BACKOFF_MILLISECONDS = 60 * 60_000;

export interface ScheduledDependencies {
  db: D1Database;
  discord: DiscordClient;
  now?: () => Date;
}

/** 1回のCronで上限件数だけを獲得し、各Reminderの失敗を他の配信から分離する。 */
export async function processScheduledReminders(
  dependencies: ScheduledDependencies,
): Promise<void> {
  const repository = new RemindersRepository(dependencies.db);
  const now = dependencies.now?.() ?? new Date();
  const nowUtc = toUtcDateTime(now);
  const leaseExpiresAt = toUtcDateTime(new Date(now.getTime() + LEASE_MILLISECONDS));
  const reminders = await repository.claimDue(nowUtc, leaseExpiresAt, REMINDER_BATCH_SIZE);

  await Promise.all(reminders.map((reminder) => deliver(reminder, repository, dependencies, now)));
}

/** 投稿成功後だけsentへ進め、失敗は状態コードと試行回数から再試行可否を決める。 */
async function deliver(
  reminder: Reminder,
  repository: RemindersRepository,
  dependencies: ScheduledDependencies,
  now: Date,
): Promise<void> {
  try {
    await dependencies.discord.createChannelMessage({
      channelId: reminder.channelId,
      content: reminder.message,
      targetUserId: reminder.targetUserId,
    });
    await repository.transition(
      reminder.id,
      reminder.guildId,
      reminder.channelId,
      'processing',
      'sent',
      { sentAt: toUtcDateTime(now) },
    );
  } catch (error) {
    const temporary = isTemporaryFailure(error);
    const exhausted = reminder.attemptCount >= REMINDER_MAX_ATTEMPTS;
    const lastError =
      error instanceof DiscordApiError ? `discord_status_${error.status}` : 'internal';
    if (!temporary || exhausted) {
      await repository.transition(
        reminder.id,
        reminder.guildId,
        reminder.channelId,
        'processing',
        'failed',
        { lastError },
      );
      return;
    }
    const delay = Math.min(2 ** (reminder.attemptCount - 1) * 60_000, MAX_BACKOFF_MILLISECONDS);
    await repository.transition(
      reminder.id,
      reminder.guildId,
      reminder.channelId,
      'processing',
      'pending',
      { nextAttemptAt: toUtcDateTime(new Date(now.getTime() + delay)), lastError },
    );
  }
}

/** Discordのrate limit・timeout・server障害と通信例外だけを一時障害として扱う。 */
function isTemporaryFailure(error: unknown): boolean {
  if (!(error instanceof DiscordApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}
