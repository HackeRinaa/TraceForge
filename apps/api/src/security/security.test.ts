import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  newApiKey,
  newSessionToken,
  looksLikeApiKey,
  sha256Hex,
  verifyPassword,
} from './crypto';
import { TokenBucketLimiter } from './rate-limiter';

describe('passwords', () => {
  it('verifies the right password and rejects wrong ones', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('uses a unique salt per hash and rejects malformed stored values', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('credentials', () => {
  it('generates high-entropy, distinct API keys with a hash and a short display prefix', () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(48);
    expect(a.hash).toBe(sha256Hex(a.secret));
    expect(a.hash).not.toContain(a.secret);
    expect(a.secret.startsWith(a.prefix)).toBe(true);
    expect(a.prefix.length).toBeLessThan(16);
    expect(looksLikeApiKey(a.secret)).toBe(true);
    expect(looksLikeApiKey('tf_live_short')).toBe(false);
  });
  it('session tokens are random and only their hash is storable', () => {
    const t = newSessionToken();
    expect(t.hash).toBe(sha256Hex(t.token));
    expect(newSessionToken().token).not.toBe(t.token);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a burst, then limits, then refills with time', () => {
    let now = 0;
    const l = new TokenBucketLimiter(10, 20, () => now);
    expect(l.take('k', 20).allowed).toBe(true);
    const denied = l.take('k', 5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
    now += 500; // refills 5 tokens
    expect(l.take('k', 5).allowed).toBe(true);
    l.close();
  });
  it('isolates keys', () => {
    const l = new TokenBucketLimiter(1, 1, () => 0);
    expect(l.take('a').allowed).toBe(true);
    expect(l.take('a').allowed).toBe(false);
    expect(l.take('b').allowed).toBe(true);
    l.close();
  });
  it('never makes an oversized request impossible: it needs a full bucket', () => {
    const l = new TokenBucketLimiter(1, 10, () => 0);
    expect(l.take('k', 1000).allowed).toBe(true);
    expect(l.take('k', 1000).allowed).toBe(false);
    l.close();
  });
});
