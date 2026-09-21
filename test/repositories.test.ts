/**
 * D1 migration と Repository の統合テスト。
 * Workers互換ランタイムの分離DBへ実際のSQLを適用し、境界条件と状態遷移を検証する。
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { toSnowflake, toUtcDateTime } from '../src/domain/types';
import { AllowlistRepository } from '../src/repositories/allowlist';
import { CheckpointsRepository } from '../src/repositories/checkpoints';
import {
  InvalidReminderTransitionError,
  RemindersRepository,
  type NewReminder,
} from '../src/repositories/reminders';
import { UsersRepository } from '../src/repositories/users';

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error('TEST_MIGRATIONS binding is required');
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('value objects', () => {
  /** snowflakeをnumberへ変換せず、64bit上限も検証する。 */
  it('rejects invalid Discord snowflakes', () => {
    expect(toSnowflake('18446744073709551615')).toBe('18446744073709551615');
    expect(() => toSnowflake('18446744073709551616')).toThrow(TypeError);
    expect(() => toSnowflake('01')).toThrow(TypeError);
  });

  /** オフセット付き入力を保存形式のUTCへ正規化する。 */
  it('normalizes date-times to UTC and rejects missing timezones', () => {
    expect(toUtcDateTime('2026-09-21T12:00:00+09:00')).toBe('2026-09-21T03:00:00.000Z');
    expect(() => toUtcDateTime('2026-09-21T12:00:00')).toThrow(TypeError);
  });
});

describe('AllowlistRepository', () => {
  /** GuildとUserの両方が有効な場合に限って許可する。 */
  it('requires both allowlist entries to be enabled', async () => {
    const repository = new AllowlistRepository(env.DB);
    const guildId = toSnowflake('10001');
    const userId = toSnowflake('20001');

    expect(await repository.isAllowed(guildId, userId)).toBe(false);
    await repository.setGuildEnabled(guildId, true);
    await repository.setUserEnabled(userId, true);
    expect(await repository.isAllowed(guildId, userId)).toBe(true);
    await repository.setUserEnabled(userId, false);
    expect(await repository.isAllowed(guildId, userId)).toBe(false);
  });
});

describe('UsersRepository', () => {
  /** UserごとのBriefを保持し、別Userへ漏らさない。 */
  it('stores a Brief only for its target user', async () => {
    const repository = new UsersRepository(env.DB);
    const userId = toSnowflake('20002');
    const otherUserId = toSnowflake('20003');
    const updatedAt = toUtcDateTime('2026-09-21T03:00:00Z');

    await repository.ensureUser(userId, 'Asia/Tokyo');
    await repository.ensureUser(otherUserId, 'UTC');
    expect(await repository.updateBrief(userId, '甘い物が好き', updatedAt)).toBe(true);
    expect(await repository.findById(userId)).toMatchObject({
      brief: '甘い物が好き',
      briefUpdatedAt: updatedAt,
    });
    expect((await repository.findById(otherUserId))?.brief).toBeNull();
  });
});

describe('CheckpointsRepository', () => {
  /** 同じChannel IDでもGuildが異なれば取得できないことを保証する。 */
  it('does not read across the compound Guild and Channel boundary', async () => {
    const repository = new CheckpointsRepository(env.DB);
    const guildId = toSnowflake('10002');
    const otherGuildId = toSnowflake('10003');
    const channelId = toSnowflake('30001');

    await repository.save({
      guildId,
      channelId,
      lastAiMessageId: toSnowflake('40001'),
      updatedAt: toUtcDateTime('2026-09-21T04:00:00Z'),
    });

    expect(await repository.find(guildId, channelId)).not.toBeNull();
    expect(await repository.find(otherGuildId, channelId)).toBeNull();
  });
});

describe('RemindersRepository', () => {
  const guildId = toSnowflake('10004');
  const channelId = toSnowflake('30002');

  /** テストごとに衝突しないReminder入力を組み立てる。 */
  function newReminder(id: string): NewReminder {
    return {
      id,
      createdByUserId: toSnowflake('20004'),
      targetUserId: null,
      guildId,
      channelId,
      message: '薬を飲む',
      remindAt: toUtcDateTime('2026-09-22T00:00:00Z'),
      createdAt: toUtcDateTime('2026-09-21T05:00:00Z'),
    };
  }

  /** IDが既知でも、GuildまたはChannelが違えば返さない。 */
  it('does not read across Guild or Channel boundaries', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(newReminder('boundary-reminder'));

    expect(await repository.findInContext('boundary-reminder', guildId, channelId)).not.toBeNull();
    expect(
      await repository.findInContext('boundary-reminder', toSnowflake('10005'), channelId),
    ).toBeNull();
    expect(
      await repository.findInContext('boundary-reminder', guildId, toSnowflake('30003')),
    ).toBeNull();
    await expect(
      repository.transition(
        'boundary-reminder',
        toSnowflake('10005'),
        channelId,
        'pending',
        'cancelled',
      ),
    ).rejects.toThrow(InvalidReminderTransitionError);
    expect(await repository.findInContext('boundary-reminder', guildId, channelId)).toMatchObject({
      status: 'pending',
    });
  });

  /** 正常系ではleaseと試行回数を記録し、送信済みへ遷移できる。 */
  it('transitions from pending through processing to sent', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(newReminder('sent-reminder'));
    await repository.transition('sent-reminder', guildId, channelId, 'pending', 'processing', {
      leaseExpiresAt: toUtcDateTime('2026-09-22T00:01:00Z'),
    });
    await repository.transition('sent-reminder', guildId, channelId, 'processing', 'sent', {
      sentAt: toUtcDateTime('2026-09-22T00:00:10Z'),
    });

    expect(await repository.findInContext('sent-reminder', guildId, channelId)).toMatchObject({
      status: 'sent',
      attemptCount: 1,
      leaseExpiresAt: null,
      sentAt: '2026-09-22T00:00:10.000Z',
    });
  });

  /** 状態機械で未定義の遷移と、古い状態を前提とした競合更新を拒否する。 */
  it('rejects invalid state transitions', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(newReminder('invalid-transition'));

    await expect(
      repository.transition('invalid-transition', guildId, channelId, 'pending', 'sent'),
    ).rejects.toThrow(InvalidReminderTransitionError);
    await expect(
      repository.transition('invalid-transition', guildId, channelId, 'processing', 'failed'),
    ).rejects.toThrow(InvalidReminderTransitionError);
  });
});
