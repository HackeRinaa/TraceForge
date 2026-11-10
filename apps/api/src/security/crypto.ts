import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { sha256Hex } from '@traceforge/domain';

// scrypt (N=2^15, r=8, p=1) is a memory-hard KDF from Node's standard library. Parameters are stored with each hash
// so they can be raised later without invalidating existing passwords.
const SCRYPT = { N: 32_768, r: 8, p: 1, keyLength: 64, maxmem: 128 * 1024 * 1024 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hash used to equalize timing when a login names an unknown email. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(SCRYPT.keyLength).toString('base64');

export { looksLikeApiKey, newApiKey, sha256Hex } from '@traceforge/domain';

/** 256-bit random session token for the cookie; only its hash is stored. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}
