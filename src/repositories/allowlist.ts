/** Guild と User の許可設定を D1 へ保存・照会する Repository。 */
import type { Snowflake } from '../domain/types';

/** 許可判定に必要な D1 操作だけを公開する。 */
export class AllowlistRepository {
  public constructor(private readonly db: D1Database) {}

  /** Guild の設定を追加または更新する。無効行も監査可能な状態で残す。 */
  public async setGuildEnabled(guildId: Snowflake, enabled: boolean): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO allowed_guilds (guild_id, enabled) VALUES (?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(guildId, enabled ? 1 : 0)
      .run();
  }

  /** User の設定を追加または更新する。 */
  public async setUserEnabled(userId: Snowflake, enabled: boolean): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO allowed_users (user_id, enabled) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(userId, enabled ? 1 : 0)
      .run();
  }

  /** Guild と User の双方が有効な場合だけ Interaction を許可する。 */
  public async isAllowed(guildId: Snowflake, userId: Snowflake): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM allowed_guilds WHERE guild_id = ? AND enabled = 1)
              AND EXISTS(SELECT 1 FROM allowed_users WHERE user_id = ? AND enabled = 1) AS allowed`,
      )
      .bind(guildId, userId)
      .first<{ allowed: number }>();

    return row?.allowed === 1;
  }
}
