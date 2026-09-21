/**
 * LLM の構造化出力を未信頼入力として検証する。
 * JSON Schema と同じ制約を実行時にも適用し、永続化前に全体を確定させる。
 */
import { toUtcDateTime, type UtcDateTime } from '../domain/types';

export const MAX_RESPONSE_LENGTH = 2000;
export const MAX_BRIEF_LENGTH = 2000;
export const MAX_REMINDER_LENGTH = 2000;

export interface AiResult {
  response: string;
  briefUpdate: string | null;
  reminderAdd: { at: UtcDateTime; message: string; target: 'channel' | 'user' } | null;
}

/** OpenAI Structured Outputs へ渡す、追加プロパティを許さない schema。 */
export const AI_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['response', 'brief_update', 'reminder_add'],
  properties: {
    response: { type: 'string', minLength: 1, maxLength: MAX_RESPONSE_LENGTH },
    brief_update: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: MAX_BRIEF_LENGTH }, { type: 'null' }],
    },
    reminder_add: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['at', 'message', 'target'],
          properties: {
            at: { type: 'string' },
            message: { type: 'string', minLength: 1, maxLength: MAX_REMINDER_LENGTH },
            target: { type: 'string', enum: ['channel', 'user'] },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

/** 空文字、過長文、未知 target、過去日時を含む出力は部分適用せず全体を拒否する。 */
export function parseAiResult(value: unknown, now: Date): AiResult {
  const root = exactRecord(value, ['response', 'brief_update', 'reminder_add']);
  const response = boundedString(root.response, MAX_RESPONSE_LENGTH);
  const briefUpdate =
    root.brief_update === null ? null : boundedString(root.brief_update, MAX_BRIEF_LENGTH);

  let reminderAdd: AiResult['reminderAdd'] = null;
  if (root.reminder_add !== null) {
    const reminder = exactRecord(root.reminder_add, ['at', 'message', 'target']);
    if (reminder.target !== 'channel' && reminder.target !== 'user') {
      throw new InvalidAiResultError();
    }
    const at = toUtcDateTime(boundedString(reminder.at, 64));
    if (new Date(at).getTime() <= now.getTime()) throw new InvalidAiResultError();
    reminderAdd = {
      at,
      message: boundedString(reminder.message, MAX_REMINDER_LENGTH),
      target: reminder.target,
    };
  }
  return { response, briefUpdate, reminderAdd };
}

/** 利用者向け詳細を持たず、LLMの不正出力だけを分類するエラー。 */
export class InvalidAiResultError extends Error {
  public constructor() {
    super('LLM returned an invalid structured result');
    this.name = 'InvalidAiResultError';
  }
}

/** 必須キーだけを持つ plain object を要求する。 */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAiResultError();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new InvalidAiResultError();
  }
  return record;
}

/** 前後の空白だけの文字列と上限超過を拒否し、原文自体は変更しない。 */
function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new InvalidAiResultError();
  }
  return value;
}
