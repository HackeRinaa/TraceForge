import 'server-only';
import { cookies } from 'next/headers';

const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Server-component GET that forwards the visitor's session cookie. Returns null when unauthenticated or missing. */
export async function serverGet<T>(path: string): Promise<T | null> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await fetch(`${API_ORIGIN}${path}`, { headers: { cookie }, cache: 'no-store' }).catch(
    () => null,
  );
  if (!res || !res.ok) return null;
  return (await res.json()) as T;
}
