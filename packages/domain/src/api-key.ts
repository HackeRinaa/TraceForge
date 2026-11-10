import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'tf_live_';

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

/**
 * `tf_live_` + 256 random bits. The full value is shown once; only the SHA-256 and a short display prefix are stored.
 * A fast hash is appropriate because the secret is high-entropy random data, not a human-chosen password.
 */
export function newApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { secret, prefix: secret.slice(0, API_KEY_PREFIX.length + 4), hash: sha256Hex(secret) };
}

export function looksLikeApiKey(value: string): boolean {
  return (
    value.startsWith(API_KEY_PREFIX) &&
    value.length >= API_KEY_PREFIX.length + 40 &&
    value.length <= 128
  );
}
