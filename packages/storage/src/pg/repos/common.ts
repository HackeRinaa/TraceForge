/** Postgres unique-constraint violation (SQLSTATE 23505), looking through ORM error wrappers. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'item';
}

/** Short random suffix that makes generated slugs unique without a retry loop. */
export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}
