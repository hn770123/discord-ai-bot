/** Scheduled Message の作成・参照・状態遷移を管理する D1 Repository。 */
import type { Snowflake, UtcDateTime } from '../domain/types';

export type ReminderStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface Reminder {
  id: string;
  createdByUserId: Snowflake;
  targetUserId: Snowflake | null;
  guildId: Snowflake;
  channelId: Snowflake;
  message: string;
  remindAt: UtcDateTime;
  status: ReminderStatus;
  attemptCount: number;
  nextAttemptAt: UtcDateTime;
  leaseExpiresAt: UtcDateTime | null;
  createdAt: UtcDateTime;
  sentAt: UtcDateTime | null;
  lastError: string | null;
}

export type NewReminder = Pick<
  Reminder,
  | 'id'
  | 'createdByUserId'
  | 'targetUserId'
  | 'guildId'
  | 'channelId'
  | 'message'
  | 'remindAt'
  | 'createdAt'
>;

interface ReminderRow {
  id: string;
  created_by_user_id: Snowflake;
  target_user_id: Snowflake | null;
  guild_id: Snowflake;
  channel_id: Snowflake;
  message: string;
  remind_at: UtcDateTime;
  status: ReminderStatus;
  attempt_count: number;
  next_attempt_at: UtcDateTime;
  lease_expires_at: UtcDateTime | null;
  created_at: UtcDateTime;
  sent_at: UtcDateTime | null;
  last_error: string | null;
}

const ALLOWED_TRANSITIONS: Readonly<Record<ReminderStatus, readonly ReminderStatus[]>> = {
  pending: ['processing', 'cancelled'],
  processing: ['pending', 'sent', 'failed'],
  sent: [],
  failed: [],
  cancelled: [],
};

/** 不正遷移と競合による遷移失敗を呼び出し側が区別するためのエラー。 */
export class InvalidReminderTransitionError extends Error {
  public constructor(from: ReminderStatus, to: ReminderStatus) {
    super(`Reminder cannot transition from ${from} to ${to}`);
    this.name = 'InvalidReminderTransitionError';
  }
}

/** Reminder のコンテキスト境界と状態機械を一か所に閉じ込める。 */
export class RemindersRepository {
  public constructor(private readonly db: D1Database) {}

  /** 新規Reminderを pending として登録し、初回試行日時を通知日時へ揃える。 */
  public async create(input: NewReminder): Promise<void> {
    if (input.message.trim().length === 0) {
      throw new TypeError('Reminder message must not be empty');
    }

    await this.db
      .prepare(
        `INSERT INTO reminders
          (id, created_by_user_id, target_user_id, guild_id, channel_id, message,
           remind_at, status, attempt_count, next_attempt_at, lease_expires_at,
           created_at, sent_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL, NULL)`,
      )
      .bind(
        input.id,
        input.createdByUserId,
        input.targetUserId,
        input.guildId,
        input.channelId,
        input.message,
        input.remindAt,
        input.remindAt,
        input.createdAt,
      )
      .run();
  }

  /** IDだけでなくGuild／Channelも一致したReminderだけを返す。 */
  public async findInContext(
    id: string,
    guildId: Snowflake,
    channelId: Snowflake,
  ): Promise<Reminder | null> {
    const row = await this.db
      .prepare(
        `SELECT id, created_by_user_id, target_user_id, guild_id, channel_id, message,
                remind_at, status, attempt_count, next_attempt_at, lease_expires_at,
                created_at, sent_at, last_error
         FROM reminders WHERE id = ? AND guild_id = ? AND channel_id = ?`,
      )
      .bind(id, guildId, channelId)
      .first<ReminderRow>();

    return row === null ? null : mapReminder(row);
  }

  /**
   * 現在状態を楽観的ロックとして使い、許可済みの遷移だけを原子的に適用する。
   * processing ではlease、再試行pendingでは次回時刻、sentでは送信時刻を必須にする。
   */
  public async transition(
    id: string,
    guildId: Snowflake,
    channelId: Snowflake,
    from: ReminderStatus,
    to: ReminderStatus,
    options: {
      leaseExpiresAt?: UtcDateTime;
      nextAttemptAt?: UtcDateTime;
      sentAt?: UtcDateTime;
      lastError?: string;
    } = {},
  ): Promise<void> {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new InvalidReminderTransitionError(from, to);
    }
    if (to === 'processing' && options.leaseExpiresAt === undefined) {
      throw new TypeError('Processing transition requires leaseExpiresAt');
    }
    if (from === 'processing' && to === 'pending' && options.nextAttemptAt === undefined) {
      throw new TypeError('Retry transition requires nextAttemptAt');
    }
    if (to === 'sent' && options.sentAt === undefined) {
      throw new TypeError('Sent transition requires sentAt');
    }

    const result = await this.db
      .prepare(
        `UPDATE reminders SET
           status = ?,
           attempt_count = attempt_count + CASE WHEN ? = 'processing' THEN 1 ELSE 0 END,
           next_attempt_at = COALESCE(?, next_attempt_at),
           lease_expires_at = CASE WHEN ? = 'processing' THEN ? ELSE NULL END,
           sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
           last_error = ?
         WHERE id = ? AND guild_id = ? AND channel_id = ? AND status = ?`,
      )
      .bind(
        to,
        to,
        options.nextAttemptAt ?? null,
        to,
        options.leaseExpiresAt ?? null,
        to,
        options.sentAt ?? null,
        options.lastError ?? null,
        id,
        guildId,
        channelId,
        from,
      )
      .run();

    if (result.meta.changes !== 1) {
      throw new InvalidReminderTransitionError(from, to);
    }
  }
}

/** D1 の snake_case 行をドメインで扱う camelCase へ明示的に変換する。 */
function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    targetUserId: row.target_user_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    message: row.message,
    remindAt: row.remind_at,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    lastError: row.last_error,
  };
}
