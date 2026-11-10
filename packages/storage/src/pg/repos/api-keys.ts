import type { ApiKeyDto } from '@traceforge/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { apiKeys, projects } from '../schema';

const keyColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const toDto = (r: KeyRow): ApiKeyDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

export async function insertApiKey(
  db: Db,
  input: {
    projectId: string;
    name: string;
    prefix: string;
    keyHash: string;
    createdBy: string | null;
  },
): Promise<ApiKeyDto> {
  const [row] = await db.insert(apiKeys).values(input).returning(keyColumns);
  if (!row) throw new Error('api key insert returned no row');
  return toDto(row);
}

export async function listApiKeys(db: Db, projectId: string): Promise<ApiKeyDto[]> {
  const rows = await db
    .select(keyColumns)
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toDto);
}

export async function getApiKey(
  db: Db,
  projectId: string,
  keyId: string,
): Promise<ApiKeyDto | null> {
  const [row] = await db
    .select(keyColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.id, keyId)));
  return row ? toDto(row) : null;
}

/** Revokes a key. Returns false when it does not exist in the project or was already revoked. */
export async function revokeApiKey(db: Db, projectId: string, keyId: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export interface ActiveKey {
  keyId: string;
  projectId: string;
}

/** Looks up an unrevoked key on a live project by the SHA-256 of its secret. */
export async function findActiveKeyByHash(db: Db, keyHash: string): Promise<ActiveKey | null> {
  const [row] = await db
    .select({ keyId: apiKeys.id, projectId: apiKeys.projectId })
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .where(
      and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), isNull(projects.deletedAt)),
    );
  return row ?? null;
}

export async function touchApiKey(db: Db, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiKeys.id, keyId));
}
