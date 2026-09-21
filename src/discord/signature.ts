/**
 * Discord Interaction の Ed25519 署名を Web Crypto API で検証する。
 * 生の本文と timestamp を連結したバイト列だけを検証対象にし、JSON再直列化による差異を防ぐ。
 */

/** リプレイ攻撃を抑止するため、現在時刻との差を許容する最大秒数。 */
export const MAX_TIMESTAMP_AGE_SECONDS = 300;

/** 署名検証に必要な値。本文は Request から一度だけ読み取った文字列を渡す。 */
export interface DiscordSignatureInput {
  publicKey: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: Date;
}

/**
 * 署名ヘッダー、timestamp の鮮度、Ed25519 署名を順に検証する。
 * malformed な外部入力では例外を外へ漏らさず false を返す。
 */
export async function verifyDiscordSignature(input: DiscordSignatureInput): Promise<boolean> {
  if (
    !isHex(input.publicKey, 64) ||
    !isHex(input.signature, 128) ||
    input.timestamp === null ||
    !/^\d{1,13}$/.test(input.timestamp)
  ) {
    return false;
  }

  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_AGE_SECONDS
  ) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(input.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const message = new TextEncoder().encode(input.timestamp + input.rawBody);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(input.signature), message);
  } catch {
    // Web Crypto が拒否する不正な鍵や署名は、認証失敗として同じ応答へ丸める。
    return false;
  }
}

/** 指定文字数の16進文字列かを確認し、null を安全に拒否する。 */
function isHex(value: string | null, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

/** Web Crypto に渡すため、検証済みの16進文字列をバイト列へ変換する。 */
function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
