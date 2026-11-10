import type { UserDto } from '@traceforge/contracts';
import { uuidParam } from '@traceforge/contracts';
import {
  findSessionUser,
  getMemberRole,
  getProjectAccess,
  type Db,
  type MemberRole,
  type ProjectAccess,
} from '@traceforge/storage';
import type { FastifyRequest } from 'fastify';
import { AppError, forbidden, notFound, parse, unauthenticated } from '../errors';
import { sha256Hex } from '../security/crypto';

export const SESSION_COOKIE = 'tf_session';

const ROLE_RANK: Record<MemberRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function assertRole(role: MemberRole, minimum: MemberRole): void {
  if (ROLE_RANK[role] < ROLE_RANK[minimum]) throw forbidden();
}

/** Resolves the session cookie to a user, or throws 401. */
export async function requireUser(req: FastifyRequest, db: Db): Promise<UserDto> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw unauthenticated();
  const user = await findSessionUser(db, sha256Hex(token));
  if (!user) throw unauthenticated();
  return user;
}

export interface ProjectContext extends ProjectAccess {
  user: UserDto;
}

/**
 * Authenticates the caller and authorizes them for `:projectId`. Every project-scoped route goes through this single
 * function, so workspace isolation cannot be forgotten on an individual route. Non-members receive 404, not 403.
 */
export async function projectContext(
  req: FastifyRequest,
  db: Db,
  minimumRole: MemberRole = 'viewer',
): Promise<ProjectContext> {
  const user = await requireUser(req, db);
  const projectId = parse(
    uuidParam,
    (req.params as { projectId?: string }).projectId,
    'Project id',
  );
  const access = await getProjectAccess(db, projectId, user.id);
  if (!access) throw notFound('Project');
  assertRole(access.role, minimumRole);
  return { user, ...access };
}

export async function workspaceRole(
  req: FastifyRequest,
  db: Db,
  minimumRole: MemberRole = 'viewer',
): Promise<{ user: UserDto; workspaceId: string; role: MemberRole }> {
  const user = await requireUser(req, db);
  const workspaceId = parse(
    uuidParam,
    (req.params as { workspaceId?: string }).workspaceId,
    'Workspace id',
  );
  const role = await getMemberRole(db, workspaceId, user.id);
  if (!role) throw notFound('Workspace');
  assertRole(role, minimumRole);
  return { user, workspaceId, role };
}

/** Unsafe, cookie-authenticated requests must come from an allowed web origin (CSRF defense in depth with SameSite). */
export function assertSameOrigin(req: FastifyRequest, allowedOrigins: readonly string[]): void {
  if (!req.cookies[SESSION_COOKIE]) return;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
    throw new AppError(403, 'CSRF_REJECTED', 'Cross-origin request rejected');
  }
}
