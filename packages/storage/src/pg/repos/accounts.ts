import type { ProjectDto, UserDto, WorkspaceDto } from '@traceforge/contracts';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { projects, sessions, users, workspaceMembers, workspaces } from '../schema';
import { isUniqueViolation, randomSuffix, slugify } from './common';

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export class EmailTakenError extends Error {
  override name = 'EmailTakenError';
}

// ---- Users ----

export interface UserRecord extends UserDto {
  passwordHash: string;
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; passwordHash: string },
): Promise<UserDto> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: input.passwordHash,
      })
      .returning({ id: users.id, email: users.email, name: users.name });
    if (!row) throw new Error('user insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailTakenError();
    throw error;
  }
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRecord | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  return row ?? null;
}

// ---- Sessions ----

export async function createSession(
  db: Db,
  input: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.insert(sessions).values(input);
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Resolves a session token hash to its user, ignoring expired sessions. Refreshes `last_seen_at` at most every 5 min. */
export async function findSessionUser(db: Db, tokenHash: string): Promise<UserDto | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(sessions.id, row.sessionId));
  }
  return { id: row.id, email: row.email, name: row.name };
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function deleteExpiredSessions(db: Db): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`now()`))
    .returning({ id: sessions.id });
  return deleted.length;
}

// ---- Workspaces ----

export async function createWorkspace(
  db: Db,
  input: { name: string; ownerId: string },
): Promise<WorkspaceDto> {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ name: input.name, slug: `${slugify(input.name)}-${randomSuffix()}` })
      .returning();
    if (!ws) throw new Error('workspace insert returned no row');
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: input.ownerId, role: 'owner' });
    return { id: ws.id, name: ws.name, slug: ws.slug, role: 'owner' };
  });
}

export async function listWorkspacesForUser(db: Db, userId: string): Promise<WorkspaceDto[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt));
}

export async function getMemberRole(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<MemberRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
}

export async function listMembers(db: Db, workspaceId: string): Promise<MemberDto[]> {
  return db
    .select({ userId: users.id, email: users.email, name: users.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.name));
}

/** Adds an existing user to a workspace. Returns null when no account has that email. */
export async function addMemberByEmail(
  db: Db,
  input: { workspaceId: string; email: string; role: Exclude<MemberRole, 'owner'> },
): Promise<MemberDto | null> {
  const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase()));
  if (!user) return null;
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: input.workspaceId, userId: user.id, role: input.role })
    .onConflictDoNothing();
  const role = await getMemberRole(db, input.workspaceId, user.id);
  return role ? { userId: user.id, email: user.email, name: user.name, role } : null;
}

// ---- Projects ----

const projectColumns = {
  id: projects.id,
  workspaceId: projects.workspaceId,
  name: projects.name,
  slug: projects.slug,
  isDemo: projects.isDemo,
  createdAt: projects.createdAt,
};

function toProjectDto(row: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  createdAt: Date;
}): ProjectDto {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function createProject(
  db: Db,
  input: { workspaceId: string; name: string; isDemo?: boolean },
): Promise<ProjectDto> {
  const [row] = await db
    .insert(projects)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      slug: `${slugify(input.name)}-${randomSuffix()}`,
      isDemo: input.isDemo ?? false,
    })
    .returning(projectColumns);
  if (!row) throw new Error('project insert returned no row');
  return toProjectDto(row);
}

export async function listProjects(db: Db, workspaceId: string): Promise<ProjectDto[]> {
  const rows = await db
    .select(projectColumns)
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.createdAt));
  return rows.map(toProjectDto);
}

export interface ProjectAccess {
  project: ProjectDto;
  role: MemberRole;
}

/**
 * The single authorization primitive for project-scoped resources: returns the project only if the user is a member
 * of its workspace. Callers must treat null as "not found" so project existence is not leaked across workspaces.
 */
export async function getProjectAccess(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectAccess | null> {
  const [row] = await db
    .select({ ...projectColumns, role: workspaceMembers.role })
    .from(projects)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, projects.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!row) return null;
  const { role, ...project } = row;
  return { project: toProjectDto(project), role };
}

export async function renameProject(db: Db, projectId: string, name: string): Promise<void> {
  await db.update(projects).set({ name }).where(eq(projects.id, projectId));
}

export async function softDeleteProject(db: Db, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ deletedAt: sql`now()` })
    .where(eq(projects.id, projectId));
}
