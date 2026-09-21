/** Phase 4 の管理境界、lease競合、再試行、mention制御をWorkers+D1上で検証する。 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDiscordClient, DiscordApiError, type DiscordClient } from '../src/discord/client';
import { toSnowflake, toUtcDateTime } from '../src/domain/types';
import { processReminderManagement } from '../src/handlers/reminder-management';
import { processScheduledReminders } from '../src/handlers/scheduled';
import { RemindersRepository, type NewReminder } from '../src/repositories/reminders';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const guildId = toSnowflake('820000000000000001');
const otherGuildId = toSnowflake('820000000000000002');
const channelId = toSnowflake('820000000000000003');
const userId = toSnowflake('820000000000000004');
const otherUserId = toSnowflake('820000000000000005');

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) throw new Error('TEST_MIGRATIONS binding is required');
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** 衝突しないIDで期限到来Reminderを作る。 */
function reminder(id: string, overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    id,
    createdByUserId: userId,
    targetUserId: null,
    guildId,
    channelId,
    message: '予定の時間です',
    remindAt: toUtcDateTime('2026-09-21T11:00:00Z'),
    createdAt: toUtcDateTime('2026-09-20T11:00:00Z'),
    ...overrides,
  };
}

/** 配信テスト用のDiscordモックを最小契約で作る。 */
function discord(post: DiscordClient['createChannelMessage']): DiscordClient {
  return {
    listChannelMessages: vi.fn(),
    editOriginalInteractionResponse: vi.fn(),
    createChannelMessage: post,
  };
}

describe('Reminder management', () => {
  /** 別の作成者やGuildから一覧・削除できず、削除はcancelledとして残る。 */
  it('limits list and cancellation to the creator and Guild', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(reminder('phase4-manage'));
    expect(await repository.listForCreatorInGuild(otherUserId, guildId)).toEqual([]);
    expect(await repository.listForCreatorInGuild(userId, otherGuildId)).toEqual([]);
    expect(await repository.cancelForCreatorInGuild('phase4-manage', otherUserId, guildId)).toBe(
      false,
    );
    expect(await repository.cancelForCreatorInGuild('phase4-manage', userId, otherGuildId)).toBe(
      false,
    );
    expect(await repository.cancelForCreatorInGuild('phase4-manage', userId, guildId)).toBe(true);
    expect(await repository.findInContext('phase4-manage', guildId, channelId)).toMatchObject({
      status: 'cancelled',
    });
  });

  /** 一覧操作は本人かつ同一Guildの情報だけをInteraction応答へ含める。 */
  it('formats only the caller reminders for a list operation', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(reminder('phase4-list-own', { message: '本人の予定' }));
    await repository.create(
      reminder('phase4-list-other', {
        createdByUserId: otherUserId,
        message: '他人の秘密の予定',
      }),
    );
    const edit = vi
      .fn<DiscordClient['editOriginalInteractionResponse']>()
      .mockResolvedValue(toSnowflake('820000000000000099'));
    await processReminderManagement(
      {
        interactionId: toSnowflake('820000000000000010'),
        applicationId: toSnowflake('820000000000000011'),
        interactionToken: 'secret',
        guildId,
        channelId,
        userId,
        prompt: null,
        operation: 'list',
        reminderId: null,
      },
      {
        db: env.DB,
        discord: {
          listChannelMessages: vi.fn(),
          editOriginalInteractionResponse: edit,
          createChannelMessage: vi.fn(),
        },
      },
    );
    const responseContent = edit.mock.calls[0]?.[0].content ?? '';
    expect(responseContent).toContain('phase4-list-own');
    expect(responseContent).not.toContain('他人の秘密の予定');
    const listed = await repository.listForCreatorInGuild(userId, guildId);
    expect(listed.map((item) => item.id)).toContain('phase4-list-own');
    expect(listed.map((item) => item.id)).not.toContain('phase4-list-other');
  });
});

describe('Scheduled reminder delivery', () => {
  /** 競合する二つの獲得処理のうち片方だけが同じReminderを取得する。 */
  it('claims a due reminder only once across concurrent workers', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(reminder('phase4-concurrent'));
    const [first, second] = await Promise.all([
      repository.claimDue(toUtcDateTime(NOW), toUtcDateTime('2026-09-21T12:01:00Z'), 100),
      repository.claimDue(toUtcDateTime(NOW), toUtcDateTime('2026-09-21T12:01:00Z'), 100),
    ]);
    expect([...first, ...second].filter((item) => item.id === 'phase4-concurrent')).toHaveLength(1);
  });

  /** 投稿成功後にだけsentへ遷移し、本人向けの通知先をDiscordへ渡す。 */
  it('marks a reminder sent after a successful post', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(
      reminder('phase4-sent', { targetUserId: userId, message: '@everyone 起床' }),
    );
    const post = vi
      .fn<DiscordClient['createChannelMessage']>()
      .mockResolvedValue(toSnowflake('820000000000000020'));
    await processScheduledReminders({ db: env.DB, discord: discord(post), now: () => NOW });
    expect(post).toHaveBeenCalledWith({
      channelId,
      content: '@everyone 起床',
      targetUserId: userId,
    });
    expect(await repository.findInContext('phase4-sent', guildId, channelId)).toMatchObject({
      status: 'sent',
      attemptCount: 1,
    });
  });

  /** 一時障害はbackoff付きpendingへ戻し、恒久的な4xxはfailedで停止する。 */
  it('retries temporary failures and stops permanent failures', async () => {
    const repository = new RemindersRepository(env.DB);
    await repository.create(reminder('phase4-retry'));
    await processScheduledReminders({
      db: env.DB,
      discord: discord(vi.fn().mockRejectedValue(new DiscordApiError(500))),
      now: () => NOW,
    });
    expect(await repository.findInContext('phase4-retry', guildId, channelId)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      nextAttemptAt: '2026-09-21T12:01:00.000Z',
      lastError: 'discord_status_500',
    });

    await repository.create(reminder('phase4-failed'));
    await processScheduledReminders({
      db: env.DB,
      discord: discord(vi.fn().mockRejectedValue(new DiscordApiError(403))),
      now: () => NOW,
    });
    expect(await repository.findInContext('phase4-failed', guildId, channelId)).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastError: 'discord_status_403',
    });
  });
});

describe('Discord scheduled message client', () => {
  /** Channel通知ではmentionなし、本人向けでは指定Userだけを許可する。 */
  it('uses an explicit allowed_mentions policy', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({ id: '1' })));
    const client = createDiscordClient('token', fetcher);
    await client.createChannelMessage({ channelId, content: '@everyone test', targetUserId: null });
    await client.createChannelMessage({ channelId, content: '<@999> test', targetUserId: userId });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      content: '@everyone test',
      allowed_mentions: { parse: [] },
    });
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      content: `<@${userId}> <@999> test`,
      allowed_mentions: { parse: [], users: [userId] },
    });
  });
});
