/**
 * Discord Interaction の外部入力を、Phase 2 で必要な最小のドメイン値へ変換する。
 * 未知の Interaction や不完全な member 情報を暗黙に受け入れない。
 */
import { toSnowflake, type Snowflake } from '../domain/types';

export const INTERACTION_TYPE_PING = 1;
export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
export const RESPONSE_TYPE_PONG = 1;
export const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
export const RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;
export const EPHEMERAL_MESSAGE_FLAG = 1 << 6;

/** 検証済みの `/ai` 呼び出し情報。Interaction token は永続化やログ出力をしない。 */
export interface AiInteraction {
  interactionId: Snowflake;
  applicationId: Snowflake;
  interactionToken: string;
  guildId: Snowflake;
  channelId: Snowflake;
  userId: Snowflake;
  prompt: string | null;
}

/** JSON入力の構造不正を HTTP 400 として扱うためのエラー。 */
export class InvalidInteractionError extends Error {
  public constructor(message = 'Invalid interaction') {
    super(message);
    this.name = 'InvalidInteractionError';
  }
}

/** JSON値から Interaction type だけを安全に取得する。 */
export function getInteractionType(value: unknown): number {
  const record = asRecord(value);
  if (typeof record.type !== 'number') throw new InvalidInteractionError();
  return record.type;
}

/** Guild 内の `/ai` Application Command だけを解析する。 */
export function parseAiInteraction(value: unknown): AiInteraction {
  const root = asRecord(value);
  const data = asRecord(root.data);
  const member = asRecord(root.member);
  const user = asRecord(member.user);

  if (root.type !== INTERACTION_TYPE_APPLICATION_COMMAND || data.name !== 'ai') {
    throw new InvalidInteractionError('Unsupported interaction');
  }
  if (typeof root.token !== 'string' || root.token.length === 0 || root.token.length > 256) {
    throw new InvalidInteractionError();
  }

  const options: unknown[] = Array.isArray(data.options) ? (data.options as unknown[]) : [];
  const promptOption = options.find((option) => {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) return false;
    const candidate = option as Record<string, unknown>;
    return candidate.name === 'prompt';
  });
  let prompt: string | null = null;
  if (promptOption !== undefined) {
    const option = asRecord(promptOption);
    if (option.type !== 3 || typeof option.value !== 'string' || option.value.length > 2000) {
      throw new InvalidInteractionError();
    }
    prompt = option.value;
  }

  try {
    return {
      interactionId: toSnowflake(requireString(root.id)),
      applicationId: toSnowflake(requireString(root.application_id)),
      interactionToken: root.token,
      guildId: toSnowflake(requireString(root.guild_id)),
      channelId: toSnowflake(requireString(root.channel_id)),
      userId: toSnowflake(requireString(user.id)),
      prompt,
    };
  } catch {
    throw new InvalidInteractionError();
  }
}

/** object 以外の値を一律で拒否し、プロパティ参照を安全にする。 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidInteractionError();
  }
  return value as Record<string, unknown>;
}

/** 必須文字列の欠落を解析エラーへ変換する。 */
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInteractionError();
  return value;
}
