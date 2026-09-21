/**
 * Discord と OpenAI のHTTP境界をモックサーバー相当の fetch router で置き換え、
 * 署名済みInteractionからD1永続化・Discord応答までを実クライアントで結合検証する。
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createOpenAiClient } from '../src/ai/client';
import { createDiscordClient } from '../src/discord/client';
import { processAiInteraction } from '../src/handlers/ai';
import { handleInteraction } from '../src/handlers/interaction';
import { CheckpointsRepository } from '../src/repositories/checkpoints';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const TIMESTAMP = String(NOW.getTime() / 1000);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) throw new Error('TEST_MIGRATIONS binding is required');
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** DiscordとOpenAIのURL別に、実APIと同形の応答を返す。 */
function createExternalApiRouter(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/channels/') && init?.method !== 'POST') {
      return Promise.resolve(Response.json([]));
    }
    if (url === 'https://api.openai.com/v1/responses') {
      return Promise.resolve(
        Response.json({
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    response: '@everyone 統合テスト応答',
                    brief_update: null,
                    reminder_add: null,
                  }),
                },
              ],
            },
          ],
        }),
      );
    }
    if (url.includes('/webhooks/') && init?.method === 'PATCH') {
      return Promise.resolve(Response.json({ id: '700000000000000006' }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

/** Discordと同様に timestamp とraw bodyをEd25519署名する。 */
async function signedRequest(body: string): Promise<{ request: Request; publicKey: string }> {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const data = new TextEncoder().encode(TIMESTAMP + body);
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, data);
  const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey);
  const hex = (value: ArrayBuffer): string =>
    [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    publicKey: hex(publicKey),
    request: new Request('https://worker.example/interactions', {
      method: 'POST',
      headers: {
        'x-signature-ed25519': hex(signature),
        'x-signature-timestamp': TIMESTAMP,
      },
      body,
    }),
  };
}

describe('Interaction to AI response integration', () => {
  /** 認証、認可、defer、両HTTPクライアント、D1 checkpointを一連で検証する。 */
  it('completes a signed interaction through mocked external APIs', async () => {
    const guildId = '700000000000000002';
    const userId = '700000000000000004';
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR REPLACE INTO allowed_guilds (guild_id, enabled) VALUES (?, 1)',
      ).bind(guildId),
      env.DB.prepare('INSERT OR REPLACE INTO allowed_users (user_id, enabled) VALUES (?, 1)').bind(
        userId,
      ),
    ]);
    const payload = JSON.stringify({
      type: 2,
      id: '700000000000000000',
      application_id: '700000000000000001',
      token: 'integration-secret-token',
      guild_id: guildId,
      channel_id: '700000000000000003',
      member: { user: { id: userId } },
      data: { name: 'ai', options: [{ name: 'prompt', type: 3, value: '統合テスト' }] },
    });
    const signed = await signedRequest(payload);
    const router = createExternalApiRouter();
    const discord = createDiscordClient('integration-bot-token', router);
    const ai = createOpenAiClient('integration-api-key', 'test-model', router);
    const pending: Promise<unknown>[] = [];

    const response = await handleInteraction(signed.request, {
      db: env.DB,
      publicKey: signed.publicKey,
      discord,
      context: { waitUntil: (promise) => pending.push(promise) },
      now: NOW,
      executeAi: (interaction) =>
        processAiInteraction(interaction, {
          db: env.DB,
          discord,
          ai,
          defaultTimezone: 'Asia/Tokyo',
          now: () => NOW,
        }),
    });

    expect(await response.json()).toEqual({ type: 5 });
    await Promise.all(pending);
    const patchCall = router.mock.calls.find(
      ([url, init]) =>
        (url instanceof Request ? url.url : url.toString()).includes('/webhooks/') &&
        init?.method === 'PATCH',
    );
    const patchBody = patchCall?.[1]?.body;
    if (typeof patchBody !== 'string') throw new TypeError('PATCH body must be a string');
    expect(JSON.parse(patchBody)).toEqual({
      content: '@everyone 統合テスト応答',
      allowed_mentions: { parse: [] },
    });
    await expect(
      new CheckpointsRepository(env.DB).find(guildId as never, '700000000000000003' as never),
    ).resolves.toMatchObject({ lastAiMessageId: '700000000000000006' });
  });
});
