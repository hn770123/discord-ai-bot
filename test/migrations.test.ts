/** 本番と同じmigration一式を空のD1へ適用し、初期schemaをロールフォワードできるか検査する。 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('D1 migrations', () => {
  /** migrationファイルを順に適用し、Repositoryが必要とする全テーブルの作成を確認する。 */
  it('applies every migration to an empty database', async () => {
    if (env.TEST_MIGRATIONS === undefined) throw new Error('TEST_MIGRATIONS binding is required');
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = result.results.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'allowed_guilds',
        'allowed_users',
        'channel_checkpoints',
        'd1_migrations',
        'reminders',
        'users',
      ]),
    );
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>(),
    ).resolves.toEqual({ count: env.TEST_MIGRATIONS.length });
  });
});
