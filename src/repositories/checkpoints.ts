/** Guild／Channelごとの会話取得位置を管理する D1 Repository。 */
import type { Snowflake, UtcDateTime } from '../domain/types';

export interface ChannelCheckpoint {
  guildId: Snowflake;
  channelId: Snowflake;
  lastAiMessageId: Snowflake;
  updatedAt: UtcDateTime;
}

interface CheckpointRow {
  guild_id: Snowflake;
  channel_id: Snowflake;
  last_ai_message_id: Snowflake;
  updated_at: UtcDateTime;
}

/** 複合キーをすべての操作に要求し、Guild／Channel境界をSQLでも保証する。 */
export class CheckpointsRepository {
  public constructor(private readonly db: D1Database) {}

  /** 対象Guildかつ対象Channelのcheckpointだけを取得する。 */
  public async find(guildId: Snowflake, channelId: Snowflake): Promise<ChannelCheckpoint | null> {
    const row = await this.db
      .prepare(
        `SELECT guild_id, channel_id, last_ai_message_id, updated_at
         FROM channel_checkpoints WHERE guild_id = ? AND channel_id = ?`,
      )
      .bind(guildId, channelId)
      .first<CheckpointRow>();

    return row === null
      ? null
      : {
          guildId: row.guild_id,
          channelId: row.channel_id,
          lastAiMessageId: row.last_ai_message_id,
          updatedAt: row.updated_at,
        };
  }

  /** AI投稿成功後の位置を複合キー単位で追加または更新する。 */
  public async save(checkpoint: ChannelCheckpoint): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO channel_checkpoints
           (guild_id, channel_id, last_ai_message_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, channel_id) DO UPDATE SET
           last_ai_message_id = excluded.last_ai_message_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        checkpoint.guildId,
        checkpoint.channelId,
        checkpoint.lastAiMessageId,
        checkpoint.updatedAt,
      )
      .run();
  }
}
