import type { Logger } from '@traceforge/logger';
import { findActiveKeyByHash, touchApiKey, type ActiveKey, type Db } from '@traceforge/storage';
import { looksLikeApiKey, sha256Hex } from '../security/crypto';

interface Entry {
  key: ActiveKey | null;
  expiresAt: number;
}

const MAX_ENTRIES = 10_000;
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Authenticates ingestion API keys with a short-lived in-memory cache so the hot path does not hit Postgres on every
 * request. Trade-off: a revoked key keeps working for up to `positiveTtlMs` on instances that cached it (default 30s);
 * revoking through this instance clears its cache immediately. Unknown keys are cached briefly to blunt guessing floods.
 */
export class ApiKeyAuthenticator {
  private readonly cache = new Map<string, Entry>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly positiveTtlMs = 30_000,
    private readonly negativeTtlMs = 5_000,
  ) {}

  async authenticate(secret: string): Promise<ActiveKey | null> {
    if (!looksLikeApiKey(secret)) return null;
    const hash = sha256Hex(secret);
    const now = Date.now();
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) {
      if (cached.key) this.touch(cached.key.keyId, now);
      return cached.key;
    }
    const key = await findActiveKeyByHash(this.db, hash);
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(hash, { key, expiresAt: now + (key ? this.positiveTtlMs : this.negativeTtlMs) });
    if (key) this.touch(key.keyId, now);
    return key;
  }

  /** Forget all cached decisions, e.g. after a key was revoked or a project deleted through this instance. */
  clear(): void {
    this.cache.clear();
  }

  private touch(keyId: string, now: number): void {
    if (now - (this.lastTouched.get(keyId) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(keyId, now);
    touchApiKey(this.db, keyId).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'failed to record api key usage');
    });
  }
}
