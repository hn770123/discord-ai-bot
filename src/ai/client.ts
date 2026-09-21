/** OpenAI Responses API を Structured Outputs 専用の薄い境界として扱う。 */
import { AI_RESULT_JSON_SCHEMA, parseAiResult, type AiResult } from './schema';

export interface AiClient {
  generate(prompt: string, now: Date): Promise<AiResult>;
}

/** APIエラーへレスポンス本文やAPI keyを含めない。 */
export class AiApiError extends Error {
  public constructor(public readonly status: number) {
    super(`AI API request failed with status ${status}`);
    this.name = 'AiApiError';
  }
}

/** fetch を注入可能にし、1回の依頼につき1回だけ Responses API を呼ぶ。 */
export function createOpenAiClient(
  apiKey: string,
  model: string,
  fetcher: typeof fetch = fetch,
): AiClient {
  return {
    async generate(prompt, now): Promise<AiResult> {
      const response = await fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: prompt,
          text: {
            format: {
              type: 'json_schema',
              name: 'discord_ai_result',
              strict: true,
              schema: AI_RESULT_JSON_SCHEMA,
            },
          },
        }),
      });
      if (!response.ok) throw new AiApiError(response.status);
      const payload: unknown = await response.json();
      const text = findOutputText(payload);
      try {
        return parseAiResult(JSON.parse(text) as unknown, now);
      } catch (error) {
        if (error instanceof SyntaxError) throw new AiApiError(502);
        throw error;
      }
    },
  };
}

/** Responses API の output 配列から assistant の output_text を抽出する。 */
function findOutputText(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new AiApiError(502);
  const output = (value as Record<string, unknown>).output;
  if (!Array.isArray(output)) throw new AiApiError(502);
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const row = part as Record<string, unknown>;
      if (row.type === 'output_text' && typeof row.text === 'string') return row.text;
    }
  }
  throw new AiApiError(502);
}
