import type { CreatedApiKeyDto } from '@traceforge/contracts';
import {
  addMemberSchema,
  createApiKeySchema,
  createProjectSchema,
  createWorkspaceSchema,
  deleteProjectSchema,
  updateProjectSchema,
  uuidParam,
} from '@traceforge/contracts';
import {
  addMemberByEmail,
  createProject,
  createWorkspace,
  getApiKey,
  insertApiKey,
  listApiKeys,
  listMembers,
  listProjects,
  renameProject,
  revokeApiKey,
  softDeleteProject,
} from '@traceforge/storage';
import type { FastifyInstance } from 'fastify';
import { AppError, notFound, parse } from '../errors';
import { newApiKey } from '../security/crypto';
import { projectContext, requireUser, workspaceRole } from '../services/access';
import type { Services } from '../services';

export function registerWorkspaceRoutes(app: FastifyInstance, s: Services): void {
  const db = s.deps.pg.db;

  app.post('/v1/workspaces', async (req, reply) => {
    const user = await requireUser(req, db);
    const { name } = parse(createWorkspaceSchema, req.body);
    return reply.status(201).send(await createWorkspace(db, { name, ownerId: user.id }));
  });

  app.get('/v1/workspaces/:workspaceId/members', async (req) => {
    const { workspaceId } = await workspaceRole(req, db);
    return { members: await listMembers(db, workspaceId) };
  });

  app.post('/v1/workspaces/:workspaceId/members', async (req, reply) => {
    const { workspaceId } = await workspaceRole(req, db, 'admin');
    const input = parse(addMemberSchema, req.body);
    const member = await addMemberByEmail(db, { workspaceId, ...input });
    if (!member) throw notFound('A user with that email');
    return reply.status(201).send(member);
  });

  app.get('/v1/workspaces/:workspaceId/projects', async (req) => {
    const { workspaceId } = await workspaceRole(req, db);
    return { projects: await listProjects(db, workspaceId) };
  });

  app.post('/v1/workspaces/:workspaceId/projects', async (req, reply) => {
    const { workspaceId } = await workspaceRole(req, db, 'admin');
    const { name } = parse(createProjectSchema, req.body);
    return reply.status(201).send(await createProject(db, { workspaceId, name }));
  });

  app.get('/v1/projects/:projectId', async (req) => (await projectContext(req, db)).project);

  app.patch('/v1/projects/:projectId', async (req) => {
    const ctx = await projectContext(req, db, 'admin');
    const { name } = parse(updateProjectSchema, req.body);
    await renameProject(db, ctx.project.id, name);
    return { ...ctx.project, name };
  });

  // Destructive: requires typing the project name. Telemetry already stored expires via the ClickHouse TTL.
  app.delete('/v1/projects/:projectId', async (req, reply) => {
    const ctx = await projectContext(req, db, 'admin');
    const { confirmName } = parse(deleteProjectSchema, req.body);
    if (confirmName !== ctx.project.name) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'The confirmation name does not match the project name',
      );
    }
    await softDeleteProject(db, ctx.project.id);
    s.authenticator.clear();
    return reply.status(204).send();
  });

  // ---- API keys ----

  app.get('/v1/projects/:projectId/api-keys', async (req) => {
    const ctx = await projectContext(req, db, 'admin');
    return { keys: await listApiKeys(db, ctx.project.id) };
  });

  app.post('/v1/projects/:projectId/api-keys', async (req, reply) => {
    const ctx = await projectContext(req, db, 'admin');
    const { name } = parse(createApiKeySchema, req.body);
    const key = newApiKey();
    const row = await insertApiKey(db, {
      projectId: ctx.project.id,
      name,
      prefix: key.prefix,
      keyHash: key.hash,
      createdBy: ctx.user.id,
    });
    const body: CreatedApiKeyDto = { ...row, secret: key.secret };
    return reply.status(201).header('cache-control', 'no-store').send(body);
  });

  // Rotation creates a successor with the same name and revokes the old key; both steps are visible in the key list.
  app.post('/v1/projects/:projectId/api-keys/:keyId/rotate', async (req, reply) => {
    const ctx = await projectContext(req, db, 'admin');
    const keyId = parse(uuidParam, (req.params as { keyId: string }).keyId, 'Key id');
    const existing = await getApiKey(db, ctx.project.id, keyId);
    if (!existing || existing.revokedAt) throw notFound('API key');
    const key = newApiKey();
    const row = await insertApiKey(db, {
      projectId: ctx.project.id,
      name: existing.name,
      prefix: key.prefix,
      keyHash: key.hash,
      createdBy: ctx.user.id,
    });
    await revokeApiKey(db, ctx.project.id, keyId);
    s.authenticator.clear();
    const body: CreatedApiKeyDto = { ...row, secret: key.secret };
    return reply.status(201).header('cache-control', 'no-store').send(body);
  });

  app.delete('/v1/projects/:projectId/api-keys/:keyId', async (req, reply) => {
    const ctx = await projectContext(req, db, 'admin');
    const keyId = parse(uuidParam, (req.params as { keyId: string }).keyId, 'Key id');
    if (!(await revokeApiKey(db, ctx.project.id, keyId))) throw notFound('API key');
    s.authenticator.clear();
    return reply.status(204).send();
  });
}
