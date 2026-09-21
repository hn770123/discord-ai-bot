/** 外部サービスや内部処理の失敗を、詳細を漏らさない利用者向け文面へ分類する。 */
import { AiApiError } from '../ai/client';
import { DiscordApiError } from '../discord/client';
import { InvalidAiResultError } from '../ai/schema';
import { classifyHttpStatus, type LogContext } from '../observability/logger';

export interface SafeFailure {
  message: string;
  service: NonNullable<LogContext['service']>;
  errorKind: NonNullable<LogContext['errorKind']>;
  status?: number;
}

/** 例外本文を外部応答やログへ転記せず、既知の境界だけを分類する。 */
export function classifyFailure(error: unknown): SafeFailure {
  if (error instanceof AiApiError || error instanceof InvalidAiResultError) {
    return {
      message: 'AIサービスの応答を処理できませんでした。時間をおいてもう一度お試しください。',
      service: 'openai',
      errorKind:
        error instanceof AiApiError
          ? (error.kind ?? classifyHttpStatus(error.status))
          : 'invalid_response',
      ...(error instanceof AiApiError && error.status > 0 ? { status: error.status } : {}),
    };
  }
  if (error instanceof DiscordApiError) {
    return {
      message: 'Discordとの通信に失敗しました。時間をおいてもう一度お試しください。',
      service: 'discord',
      errorKind: error.kind ?? classifyHttpStatus(error.status),
      ...(error.status > 0 ? { status: error.status } : {}),
    };
  }
  return {
    message: '処理中に問題が発生しました。時間をおいてもう一度お試しください。',
    service: 'worker',
    errorKind: 'internal',
  };
}
