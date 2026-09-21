/** Discord REST クライアントのURL、本文、mention抑止を外部通信なしで検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { createDiscordClient, DiscordApiError } from '../src/discord/client';
import { toSnowflake } from '../src/domain/types';

describe('Discord client', () => {
  /** 元Interaction ResponseをPATCHし、Bot認証ヘッダーやmentionを送らない。 */
  it('edits the original response with mentions disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createDiscordClient(fetcher);

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
    const client = createDiscordClient(fetcher);

    await expect(
      client.editOriginalInteractionResponse({
        applicationId: toSnowflake('100000000000000001'),
        interactionToken: 'secret-token',
        content: 'test',
      }),
    ).rejects.toEqual(new DiscordApiError(500));
  });
});
