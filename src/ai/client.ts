/** Cloudflare Workers AI バインディングを構造化出力専用の境界として扱う。 */
import { AI_RESULT_JSON_SCHEMA, parseAiResult, type AiResult } from './schema';

export interface AiClient {
  generate(prompt: string, now: Date): Promise<AiResult>;
}

/** Workers AI 呼び出しをテスト時に差し替えるための最小契約。 */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export const WORKERS_AI_TIMEOUT_MILLISECONDS = 30_000;

/** APIエラーへモデル入力や応答本文を含めない。 */
export class AiApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly kind?: 'timeout' | 'network',
  ) {
    super(`AI binding request failed with status ${status}`);
    this.name = 'AiApiError';
  }
}

/** 1回の依頼につき Workers AI の指定モデルを1回だけ呼び出す。 */
export function createCloudflareAiClient(
  ai: WorkersAiBinding,
  model: string,
  timeoutMilliseconds = WORKERS_AI_TIMEOUT_MILLISECONDS,
): AiClient {
  return {
    async generate(prompt, now): Promise<AiResult> {
      let payload: unknown;
      try {
        payload = await ai.run(
          model,
          {
            prompt,
            response_format: {
              type: 'json_schema',
              json_schema: AI_RESULT_JSON_SCHEMA,
            },
          },
          { signal: AbortSignal.timeout(timeoutMilliseconds) },
        );
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        throw new AiApiError(0, timedOut ? 'timeout' : 'network');
      }

      return parseAiResult(findStructuredResponse(payload), now);
    },
  };
}

/** JSON Mode の `response` を抽出し、文字列形式も安全に再検証する。 */
function findStructuredResponse(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) throw new AiApiError(502);
  const response = (value as Record<string, unknown>).response;
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response) as unknown;
  } catch {
    throw new AiApiError(502);
  }
}
