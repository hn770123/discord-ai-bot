/**
 * 永続化境界で共有する値オブジェクト。
 * Discord ID を number に変換する事故と、UTC でない日時の混入を型と実行時検証で防ぐ。
 */

/** Discord snowflake と検証済み文字列を区別するためのブランド型。 */
export type Snowflake = string & { readonly __brand: 'Snowflake' };

/** UTC に正規化済みの ISO 8601 文字列を区別するためのブランド型。 */
export type UtcDateTime = string & { readonly __brand: 'UtcDateTime' };

const MAX_SNOWFLAKE = (1n << 64n) - 1n;

/**
 * 外部入力を Discord snowflake として検証する。
 * 符号なし64bit整数の10進表記だけを受け入れ、以後も文字列のまま扱う。
 */
export function toSnowflake(value: string): Snowflake {
  if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_SNOWFLAKE) {
    throw new TypeError('Discord ID must be a positive unsigned 64-bit decimal string');
  }

  return value as Snowflake;
}

/**
 * Date または日時文字列をミリ秒精度の UTC ISO 8601 形式へ正規化する。
 * タイムゾーンを持たない文字列は実行環境依存になるため拒否する。
 */
export function toUtcDateTime(value: Date | string): UtcDateTime {
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError('Date-time string must include a timezone');
  }

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Date-time value is invalid');
  }

  return date.toISOString() as UtcDateTime;
}

/** IANA timezone 名を実行ランタイムの Intl データで検証する。 */
export function assertTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: value }).format();
  } catch {
    throw new TypeError('Timezone must be a valid IANA timezone');
  }

  return value;
}
