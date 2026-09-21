/**
 * Discord REST API の会話履歴取得と Interaction Response 編集を提供するクライアント。
 * Interaction token は URL 以外へ複製せず、失敗時のエラー本文にも含めない。
 */
import { toSnowflake, type Snowflake } from '../domain/types';

export interface EditInteractionResponseInput {
  applicationId: Snowflake;
  interactionToken: string;
  content: string;
}

/** プロンプトへ渡せる最小限の Discord Message。 */
export interface DiscordMessage {
  id: Snowflake;
  guildId: Snowflake;
  channelId: Snowflake;
  authorId: Snowflake;
  authorIsBot: boolean;
  content: string;
  timestamp: string;
}

export interface ListChannelMessagesInput {
  guildId: Snowflake;
  channelId: Snowflake;
  after?: Snowflake;
}

/** Cron から通常の Channel Message を投稿するための入力。 */
export interface CreateChannelMessageInput {
  channelId: Snowflake;
  content: string;
  /** null はチャンネル通知、指定時はその利用者だけを通知する。 */
  targetUserId: Snowflake | null;
}

export interface DiscordClient {
  listChannelMessages(input: ListChannelMessagesInput): Promise<DiscordMessage[]>;
  editOriginalInteractionResponse(input: EditInteractionResponseInput): Promise<Snowflake>;
  createChannelMessage(input: CreateChannelMessageInput): Promise<Snowflake>;
}

/** Discord API の失敗を秘密情報を含まない状態コードだけで通知する。 */
export class DiscordApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Discord API request failed with status ${status}`);
    this.name = 'DiscordApiError';
  }
}

/** Workers の fetch を注入可能にし、外部通信なしで契約テストできるクライアントを作る。 */
export function createDiscordClient(
  botToken: string,
  fetcher: typeof fetch = fetch,
): DiscordClient {
  return {
    /** 最大100件だけを取得し、レスポンスのテナント境界を呼び出し元の値と照合する。 */
    async listChannelMessages(input): Promise<DiscordMessage[]> {
      const url = new URL(`https://discord.com/api/v10/channels/${input.channelId}/messages`);
      url.searchParams.set('limit', '100');
      if (input.after !== undefined) url.searchParams.set('after', input.after);
      const response = await fetcher(url, {
        headers: { authorization: `Bot ${botToken}` },
      });
      if (!response.ok) throw new DiscordApiError(response.status);

      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new DiscordApiError(502);
      return value.map((item) => parseMessage(item, input));
    },

    /** 編集後の Message ID を返し、成功した AI 参加位置だけを checkpoint 化できるようにする。 */
    async editOriginalInteractionResponse(input): Promise<Snowflake> {
      const url = `https://discord.com/api/v10/webhooks/${input.applicationId}/${encodeURIComponent(input.interactionToken)}/messages/@original`;
      const response = await fetcher(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: input.content,
          // AI生成文を扱う後続Phaseでも意図しないmentionを発火させない既定値にする。
          allowed_mentions: { parse: [] },
        }),
      });
      if (!response.ok) throw new DiscordApiError(response.status);
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || !('id' in value)) {
        throw new DiscordApiError(502);
      }
      return toSnowflake(String(value.id));
    },

    /** LLM本文中のmentionを無効化し、本人向けの場合だけ明示したUser IDを許可する。 */
    async createChannelMessage(input): Promise<Snowflake> {
      const response = await fetcher(
        `https://discord.com/api/v10/channels/${input.channelId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bot ${botToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            content:
              input.targetUserId === null
                ? input.content
                : `<@${input.targetUserId}> ${input.content}`,
            allowed_mentions:
              input.targetUserId === null
                ? { parse: [] }
                : { parse: [], users: [input.targetUserId] },
          }),
        },
      );
      if (!response.ok) throw new DiscordApiError(response.status);
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || !('id' in value)) {
        throw new DiscordApiError(502);
      }
      return toSnowflake(String(value.id));
    },
  };
}

/** Discord の未信頼 JSON を検証し、別 Guild／Channel の混入を即座に拒否する。 */
function parseMessage(value: unknown, expected: ListChannelMessagesInput): DiscordMessage {
  if (typeof value !== 'object' || value === null) throw new DiscordApiError(502);
  const row = value as Record<string, unknown>;
  const author = row.author;
  if (typeof author !== 'object' || author === null) throw new DiscordApiError(502);
  const authorRow = author as Record<string, unknown>;
  try {
    const guildId = toSnowflake(String(row.guild_id));
    const channelId = toSnowflake(String(row.channel_id));
    if (guildId !== expected.guildId || channelId !== expected.channelId) {
      throw new DiscordApiError(502);
    }
    if (typeof row.content !== 'string' || typeof row.timestamp !== 'string') {
      throw new DiscordApiError(502);
    }
    return {
      id: toSnowflake(String(row.id)),
      guildId,
      channelId,
      authorId: toSnowflake(String(authorRow.id)),
      authorIsBot: authorRow.bot === true,
      content: row.content,
      timestamp: row.timestamp,
    };
  } catch (error) {
    if (error instanceof DiscordApiError) throw error;
    throw new DiscordApiError(502);
  }
}
