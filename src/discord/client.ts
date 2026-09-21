/**
 * Discord REST API のうち、元の Interaction Response 編集だけを提供するクライアント。
 * Interaction token は URL 以外へ複製せず、失敗時のエラー本文にも含めない。
 */
import type { Snowflake } from '../domain/types';

export interface EditInteractionResponseInput {
  applicationId: Snowflake;
  interactionToken: string;
  content: string;
}

export interface DiscordClient {
  editOriginalInteractionResponse(input: EditInteractionResponseInput): Promise<void>;
}

/** Discord API の失敗を秘密情報を含まない状態コードだけで通知する。 */
export class DiscordApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Discord API request failed with status ${status}`);
    this.name = 'DiscordApiError';
  }
}

/** Workers の fetch を注入可能にし、外部通信なしで契約テストできるクライアントを作る。 */
export function createDiscordClient(fetcher: typeof fetch = fetch): DiscordClient {
  return {
    async editOriginalInteractionResponse(input): Promise<void> {
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
    },
  };
}
