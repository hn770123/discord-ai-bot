/**
 * Worker の構造化ログを安全なフィールドだけに限定する。
 * 会話本文、Brief、認証情報を引数として受け取れない型にして、誤出力を設計段階で防ぐ。
 */

/** ログを追跡するための、秘密情報を含まない相関情報。 */
export interface LogContext {
  requestId?: string;
  interactionId?: string;
  reminderId?: string;
  service?: 'discord' | 'openai' | 'd1' | 'worker';
  status?: number;
  outcome?: 'accepted' | 'rejected' | 'succeeded' | 'failed' | 'retrying';
  errorKind?:
    | 'timeout'
    | 'network'
    | 'rate_limited'
    | 'client'
    | 'server'
    | 'invalid_response'
    | 'internal';
}

export interface StructuredLogger {
  info(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

type LogSink = (record: string) => void;

/** JSON 1行形式の logger を作り、ログ集約側で相関IDを検索可能にする。 */
export function createLogger(sink: LogSink = console.log): StructuredLogger {
  const write = (level: 'info' | 'error', event: string, context: LogContext = {}): void => {
    sink(JSON.stringify({ level, event, ...context }));
  };
  return {
    info: (event, context) => write('info', event, context),
    error: (event, context) => write('error', event, context),
  };
}

/** 外部APIのHTTP状態を、レスポンス本文を使わず運用向け分類へ変換する。 */
export function classifyHttpStatus(status: number): NonNullable<LogContext['errorKind']> {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'invalid_response';
}
