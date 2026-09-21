/** User Brief と利用者のタイムゾーンを管理する D1 Repository。 */
import { assertTimeZone, type Snowflake, type UtcDateTime } from '../domain/types';

export interface UserProfile {
  discordUserId: Snowflake;
  brief: string | null;
  timezone: string;
  briefUpdatedAt: UtcDateTime | null;
}

interface UserRow {
  discord_user_id: Snowflake;
  brief: string | null;
  timezone: string;
  brief_updated_at: UtcDateTime | null;
}

/** User 単位の読み書きを提供し、他Userの情報を混在させない。 */
export class UsersRepository {
  public constructor(private readonly db: D1Database) {}

  /** 初回利用者を作成する。既存 Brief は上書きしない。 */
  public async ensureUser(userId: Snowflake, timezone: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (discord_user_id, brief, timezone, brief_updated_at)
         VALUES (?, NULL, ?, NULL) ON CONFLICT (discord_user_id) DO NOTHING`,
      )
      .bind(userId, assertTimeZone(timezone))
      .run();
  }

  /** 指定Userのプロフィールだけを取得し、未登録なら null を返す。 */
  public async findById(userId: Snowflake): Promise<UserProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT discord_user_id, brief, timezone, brief_updated_at
         FROM users WHERE discord_user_id = ?`,
      )
      .bind(userId)
      .first<UserRow>();

    return row === null
      ? null
      : {
          discordUserId: row.discord_user_id,
          brief: row.brief,
          timezone: row.timezone,
          briefUpdatedAt: row.brief_updated_at,
        };
  }

  /** LLMで検証済みの Brief と更新日時を同時に保存する。 */
  public async updateBrief(
    userId: Snowflake,
    brief: string,
    updatedAt: UtcDateTime,
  ): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE users SET brief = ?, brief_updated_at = ? WHERE discord_user_id = ?')
      .bind(brief, updatedAt, userId)
      .run();

    return result.meta.changes === 1;
  }
}
