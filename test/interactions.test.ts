/**
 * Discord Interaction 入口のセキュリティと応答契約を検証する。
 * テスト内で Ed25519 鍵を生成し、本文改ざんや期限切れを実署名検証へ通す。
 */
import { describe, expect, it, vi } from 'vitest';
import { handleInteraction } from '../src/handlers/interaction';
import { verifyDiscordSignature } from '../src/discord/signature';
import type { DiscordClient } from '../src/discord/client';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const TIMESTAMP = String(NOW.getTime() / 1000);

/** テストごとに独立した鍵を作り、Discordと同じ timestamp + raw body へ署名する。 */
async function createSignedRequest(
  body: string,
  timestamp = TIMESTAMP,
): Promise<{
  request: Request;
  publicKey: string;
}> {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKey = bytesToHex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const signature = bytesToHex(
    await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new TextEncoder().encode(timestamp + body),
    ),
  );
  return {
    publicKey,
    request: new Request('https://worker.example/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': signature,
        'x-signature-timestamp': timestamp,
      },
      body,
    }),
  };
}

/** ArrayBuffer を署名ヘッダーと公開鍵に使う小文字16進表記へ変換する。 */
function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** allowlist の問い合わせ結果だけを実装する最小 D1 モックを作る。 */
function createDb(allowed: boolean, queried: ReturnType<typeof vi.fn>): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: (...values: unknown[]) => {
        queried(...values);
        return { first: () => Promise.resolve({ allowed: allowed ? 1 : 0 }) };
      },
    })),
  } as unknown as D1Database;
}

/** 正常な `/ai` payload を必要に応じて上書きして作る。 */
function aiPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 2,
    id: '100000000000000000',
    application_id: '100000000000000001',
    token: 'interaction-token-must-not-be-logged',
    guild_id: '100000000000000002',
    channel_id: '100000000000000003',
    member: { user: { id: '100000000000000004' } },
    data: { name: 'ai', options: [{ name: 'prompt', type: 3, value: 'こんにちは' }] },
    ...overrides,
  });
}

describe('Discord signature', () => {
  /** 生本文が1文字でも変われば署名検証に失敗することを確認する。 */
  it('rejects a tampered body', async () => {
    const signed = await createSignedRequest('{"type":1}');
    expect(
      await verifyDiscordSignature({
        publicKey: signed.publicKey,
        signature: signed.request.headers.get('x-signature-ed25519'),
        timestamp: TIMESTAMP,
        rawBody: '{"type":2}',
        now: NOW,
      }),
    ).toBe(false);
  });

  /** 署名が正しくても鮮度上限を超えた timestamp は拒否する。 */
  it('rejects an expired timestamp', async () => {
    const timestamp = String(NOW.getTime() / 1000 - 301);
    const signed = await createSignedRequest('{"type":1}', timestamp);
    expect(
      await verifyDiscordSignature({
        publicKey: signed.publicKey,
        signature: signed.request.headers.get('x-signature-ed25519'),
        timestamp,
        rawBody: '{"type":1}',
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('Interaction handler', () => {
  /** DiscordのEndpoint検証で使われるPINGへ、署名検証後にPONGを返す。 */
  it('responds to a signed PING', async () => {
    const signed = await createSignedRequest('{"type":1}');
    const response = await handleInteraction(signed.request, {
      db: createDb(false, vi.fn()),
      publicKey: signed.publicKey,
      discord: { listChannelMessages: vi.fn(), editOriginalInteractionResponse: vi.fn() },
      context: { waitUntil: vi.fn() },
      now: NOW,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  /** 署名ヘッダー欠落時は JSON解析やD1照会前に401で終了する。 */
  it('rejects a missing signature before querying D1', async () => {
    const queried = vi.fn();
    const response = await handleInteraction(
      new Request('https://worker.example/interactions', { method: 'POST', body: aiPayload() }),
      {
        db: createDb(true, queried),
        publicKey: '00'.repeat(32),
        discord: { listChannelMessages: vi.fn(), editOriginalInteractionResponse: vi.fn() },
        context: { waitUntil: vi.fn() },
        now: NOW,
      },
    );

    expect(response.status).toBe(401);
    expect(queried).not.toHaveBeenCalled();
  });

  /** 許可外では ephemeral 応答だけを返し、Discord APIや後続処理を呼ばない。 */
  it('returns an ephemeral denial without external API calls', async () => {
    const signed = await createSignedRequest(aiPayload());
    const edit = vi.fn();
    const processAi = vi.fn();
    const waitUntil = vi.fn();
    const response = await handleInteraction(signed.request, {
      db: createDb(false, vi.fn()),
      publicKey: signed.publicKey,
      discord: { listChannelMessages: vi.fn(), editOriginalInteractionResponse: edit },
      context: { waitUntil },
      processAi,
      now: NOW,
    });

    expect(await response.json()).toEqual({
      type: 4,
      data: { content: 'このコマンドを利用する権限がありません。', flags: 64 },
    });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(processAi).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  /** 許可後はtype 5を即時返し、後続処理と元レスポンス編集をwaitUntilへ登録する。 */
  it('defers an allowed command and edits the original response asynchronously', async () => {
    const signed = await createSignedRequest(aiPayload());
    const pending: Promise<unknown>[] = [];
    const edit = vi
      .fn<DiscordClient['editOriginalInteractionResponse']>()
      .mockResolvedValue('100000000000000005' as never);
    const response = await handleInteraction(signed.request, {
      db: createDb(true, vi.fn()),
      publicKey: signed.publicKey,
      discord: { listChannelMessages: vi.fn(), editOriginalInteractionResponse: edit },
      context: { waitUntil: (promise) => pending.push(promise) },
      processAi: (interaction) => Promise.resolve(`受信: ${interaction.prompt}`),
      now: NOW,
    });

    expect(await response.json()).toEqual({ type: 5 });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(edit).toHaveBeenCalledWith({
      applicationId: '100000000000000001',
      interactionToken: 'interaction-token-must-not-be-logged',
      content: '受信: こんにちは',
    });
  });
});
