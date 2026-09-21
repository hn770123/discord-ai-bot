/** 構造化ログと安全な利用者向けエラー分類が機微情報を受け渡さないことを検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { AiApiError } from '../src/ai/client';
import { classifyFailure } from '../src/domain/failures';
import { createLogger } from '../src/observability/logger';

describe('safe failures and structured logs', () => {
  /** API本文ではなくサービス・状態・安全な固定文だけを公開する。 */
  it('classifies an AI failure without exposing credentials or content', () => {
    expect(classifyFailure(new AiApiError(429))).toEqual({
      message: 'AIサービスの応答を処理できませんでした。時間をおいてもう一度お試しください。',
      service: 'openai',
      errorKind: 'rate_limited',
      status: 429,
    });
  });

  /** 相関ID付きJSONに許可フィールドだけが出力される。 */
  it('writes correlation identifiers as one structured record', () => {
    const sink = vi.fn();
    createLogger(sink).error('interaction.failed', {
      requestId: 'request-id',
      interactionId: 'interaction-id',
      service: 'openai',
      errorKind: 'timeout',
      outcome: 'failed',
    });

    const record = sink.mock.calls[0]?.[0] as string;
    expect(JSON.parse(record)).toEqual({
      level: 'error',
      event: 'interaction.failed',
      requestId: 'request-id',
      interactionId: 'interaction-id',
      service: 'openai',
      errorKind: 'timeout',
      outcome: 'failed',
    });
    expect(record).not.toMatch(/token|brief|conversation|content/i);
  });
});
