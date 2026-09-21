/** Discord Message を時系列の安全な LLM 入力へ正規化する。 */
import type { DiscordMessage } from '../discord/client';
import type { Snowflake } from './types';

export interface ConversationEntry {
  messageId: Snowflake;
  authorId: Snowflake;
  authorType: 'bot' | 'user';
  content: string;
  timestamp: string;
}

/** Guild／Channelを再検査し、空投稿を除外して古い順に最大100件へ揃える。 */
export function normalizeConversation(
  messages: readonly DiscordMessage[],
  guildId: Snowflake,
  channelId: Snowflake,
): ConversationEntry[] {
  if (messages.length > 100) throw new TypeError('Conversation exceeds the history limit');
  return messages
    .map((message) => {
      if (message.guildId !== guildId || message.channelId !== channelId) {
        throw new TypeError('Conversation crossed a Guild or Channel boundary');
      }
      if (Number.isNaN(new Date(message.timestamp).getTime())) {
        throw new TypeError('Message timestamp is invalid');
      }
      return {
        messageId: message.id,
        authorId: message.authorId,
        authorType: message.authorIsBot ? ('bot' as const) : ('user' as const),
        content: message.content,
        timestamp: message.timestamp,
      };
    })
    .filter((message) => message.content.trim().length > 0)
    .sort((left, right) => {
      const timeDifference =
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
      return timeDifference !== 0
        ? timeDifference
        : BigInt(left.messageId) < BigInt(right.messageId)
          ? -1
          : 1;
    });
}
