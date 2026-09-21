/** Discord REST クライアントのURL、本文、mention抑止を外部通信なしで検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { createDiscordClient, DiscordApiError } from '../src/discord/client';
import { toSnowflake } from '../src/domain/types';

describe('Discord client', () => {
  /** 元Interaction ResponseをPATCHし、Bot認証ヘッダーやmentionを送らない。 */
  it('edits the original response with mentions disabled', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: '100000000000000009' }));
    const client = createDiscordClient('bot-token', fetcher);

    await client.editOriginalInteractionResponse({
      applicationId: toSnowflake('100000000000000001'),
      interactionToken: 'token/value',
      content: '@everyone テスト',
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://discord.com/api/v10/webhooks/100000000000000001/token%2Fvalue/messages/@original',
    );
    expect(init?.method).toBe('PATCH');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({
      content: '@everyone テスト',
      allowed_mentions: { parse: [] },
    });
  });

  /** API失敗時もレスポンス本文やtokenを例外へ含めない。 */
  it('reports only the Discord status on failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('sensitive response', { status: 500 }));
    const client = createDiscordClient('bot-token', fetcher);

    await expect(
      client.editOriginalInteractionResponse({
        applicationId: toSnowflake('100000000000000001'),
        interactionToken: 'secret-token',
        content: 'test',
      }),
    ).rejects.toEqual(new DiscordApiError(500));
  });

  /** 履歴取得では100件上限とcheckpointを指定し、別Channelの応答を拒否する。 */
  it('gets at most 100 messages after the checkpoint and verifies context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([
        {
          id: '100000000000000010',
          guild_id: '100000000000000001',
          channel_id: '100000000000000002',
          author: { id: '100000000000000003' },
          content: '会話',
          timestamp: '2026-09-21T11:00:00.000Z',
        },
      ]),
    );
    const client = createDiscordClient('bot-token', fetcher);
    await expect(
      client.listChannelMessages({
        guildId: toSnowflake('100000000000000001'),
        channelId: toSnowflake('100000000000000002'),
        after: toSnowflake('100000000000000004'),
      }),
    ).resolves.toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get('limit')).toBe('100');
    expect((url as URL).searchParams.get('after')).toBe('100000000000000004');
    expect(init?.headers).toEqual({ authorization: 'Bot bot-token' });
  });
});
