/** Phase 3 の構造化出力、会話境界、永続化順序を外部通信なしで検証する。 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAiResult } from '../src/ai/schema';
import { createOpenAiClient, type AiClient } from '../src/ai/client';
import type { DiscordClient, DiscordMessage } from '../src/discord/client';
import { normalizeConversation } from '../src/domain/conversation';
import { toSnowflake, toUtcDateTime } from '../src/domain/types';
import { processAiInteraction } from '../src/handlers/ai';
import { CheckpointsRepository } from '../src/repositories/checkpoints';
import { RemindersRepository } from '../src/repositories/reminders';
import { UsersRepository } from '../src/repositories/users';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const guildId = toSnowflake('810000000000000001');
const channelId = toSnowflake('810000000000000002');
const userId = toSnowflake('810000000000000003');

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) throw new Error('TEST_MIGRATIONS binding is required');
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('AI result schema', () => {
  /** 正常値は日時をUTCへ正規化する。 */
  it('normalizes a valid future reminder', () => {
    expect(
      parseAiResult(
        {
          response: '了解',
          brief_update: null,
          reminder_add: { at: '2026-09-22T07:00:00+09:00', message: '起きる時間', target: 'user' },
        },
        NOW,
      ).reminderAdd?.at,
    ).toBe('2026-09-21T22:00:00.000Z');
  });

  /** 過去日時、任意target、空文字、Discord上限超過をすべて拒否する。 */
  it('rejects unsafe structured values', () => {
    const base = { response: 'ok', brief_update: null, reminder_add: null };
    expect(() => parseAiResult({ ...base, response: '' }, NOW)).toThrow();
    expect(() => parseAiResult({ ...base, response: 'x'.repeat(2001) }, NOW)).toThrow();
    expect(() =>
      parseAiResult(
        { ...base, reminder_add: { at: '2026-09-20T00:00:00Z', message: 'x', target: 'user' } },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      parseAiResult(
        { ...base, reminder_add: { at: '2026-09-22T00:00:00Z', message: 'x', target: userId } },
        NOW,
      ),
    ).toThrow();
  });

  /** Responses APIが不正JSONを返しても、保存可能な結果として扱わない。 */
  it('rejects invalid JSON returned by the Responses API', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: [{ content: [{ type: 'output_text', text: '{invalid-json' }] }],
      }),
    );
    const client = createOpenAiClient('api-key', 'test-model', fetcher);

    await expect(client.generate('prompt', NOW)).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('conversation normalization', () => {
  /** Discordの逆順応答を時系列へ直し、別Guild／Channelを混ぜない。 */
  it('sorts messages and rejects a crossed boundary', () => {
    const message = (id: string, timestamp: string): DiscordMessage => ({
      id: toSnowflake(id),
      guildId,
      channelId,
      authorId: userId,
      authorIsBot: false,
      content: id,
      timestamp,
    });
    expect(
      normalizeConversation(
        [
          message('810000000000000012', '2026-09-21T11:02:00Z'),
          message('810000000000000011', '2026-09-21T11:01:00Z'),
        ],
        guildId,
        channelId,
      ).map((entry) => entry.messageId),
    ).toEqual(['810000000000000011', '810000000000000012']);
    expect(() =>
      normalizeConversation(
        [
          {
            ...message('810000000000000013', '2026-09-21T11:03:00Z'),
            guildId: toSnowflake('910000000000000001'),
          },
        ],
        guildId,
        channelId,
      ),
    ).toThrow();
  });
});

describe('AI workflow', () => {
  /** 初回履歴0件を扱い、Brief／Reminder／応答の後でcheckpointを進める。 */
  it('processes an empty first conversation and remains reminder-idempotent', async () => {
    const interactionId = toSnowflake('810000000000000020');
    const editResponse = vi.fn().mockResolvedValue(toSnowflake('810000000000000021'));
    const discord: DiscordClient = {
      listChannelMessages: vi.fn().mockResolvedValue([]),
      editOriginalInteractionResponse: editResponse,
    };
    const ai: AiClient = {
      generate: vi.fn().mockResolvedValue({
        response: '@everyone 了解',
        briefUpdate: '朝型',
        reminderAdd: { at: toUtcDateTime('2026-09-22T00:00:00Z'), message: '起床', target: 'user' },
      }),
    };
    const interaction = {
      interactionId,
      applicationId: toSnowflake('810000000000000004'),
      interactionToken: 'secret',
      guildId,
      channelId,
      userId,
      prompt: '起こして',
    };
    const dependencies = { db: env.DB, discord, ai, defaultTimezone: 'Asia/Tokyo', now: () => NOW };

    await processAiInteraction(interaction, dependencies);
    await processAiInteraction(interaction, dependencies);

    expect((await new UsersRepository(env.DB).findById(userId))?.brief).toBe('朝型');
    expect(
      await new RemindersRepository(env.DB).findInContext(interactionId, guildId, channelId),
    ).toMatchObject({ targetUserId: userId });
    expect(await new CheckpointsRepository(env.DB).find(guildId, channelId)).toMatchObject({
      lastAiMessageId: '810000000000000021',
    });
    expect(editResponse).toHaveBeenCalledWith(
      expect.objectContaining({ content: '@everyone 了解' }),
    );
  });

  /** LLM失敗時はBrief、Reminder、checkpointを変更しない。 */
  it('does not persist AI output when generation fails', async () => {
    const failingUser = toSnowflake('810000000000000030');
    const editResponse = vi.fn();
    const discord: DiscordClient = {
      listChannelMessages: vi.fn().mockResolvedValue([]),
      editOriginalInteractionResponse: editResponse,
    };
    const ai: AiClient = { generate: vi.fn().mockRejectedValue(new Error('invalid output')) };
    await expect(
      processAiInteraction(
        {
          interactionId: toSnowflake('810000000000000031'),
          applicationId: toSnowflake('810000000000000004'),
          interactionToken: 'secret',
          guildId,
          channelId: toSnowflake('810000000000000032'),
          userId: failingUser,
          prompt: null,
        },
        { db: env.DB, discord, ai, defaultTimezone: 'UTC', now: () => NOW },
      ),
    ).rejects.toThrow('invalid output');
    expect((await new UsersRepository(env.DB).findById(failingUser))?.brief).toBeNull();
    expect(editResponse).not.toHaveBeenCalled();
  });
});
