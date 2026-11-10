import { loginSchema, registerSchema, type MeResponse } from '@traceforge/contracts';
import {
  EmailTakenError,
  createSession,
  createUser,
  createWorkspace,
  deleteSession,
  findUserByEmail,
  listWorkspacesForUser,
} from '@traceforge/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, parse } from '../errors';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  newSessionToken,
  sha256Hex,
  verifyPassword,
} from '../security/crypto';
import { SESSION_COOKIE, requireUser } from '../services/access';
import type { Services } from '../services';

export function registerAuthRoutes(app: FastifyInstance, s: Services): void {
  const { pg, cfg, metrics } = s.deps;
  const db = pg.db;

  const startSession = async (reply: FastifyReply, userId: string): Promise<void> => {
    const { token, hash } = newSessionToken();
    const ttlMs = cfg.SESSION_TTL_HOURS * 3_600_000;
    await createSession(db, { userId, tokenHash: hash, expiresAt: new Date(Date.now() + ttlMs) });
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.NODE_ENV === 'production',
      path: '/',
      maxAge: Math.floor(ttlMs / 1000),
    });
  };

  const throttle = (key: string): void => {
    const d = s.authLimiter.take(key);
    if (!d.allowed) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many attempts. Please wait before trying again.',
        undefined,
        {
          'retry-after': String(d.retryAfterSeconds),
        },
      );
    }
  };

  const me = async (userId: string, user: MeResponse['user']): Promise<MeResponse> => ({
    user,
    workspaces: await listWorkspacesForUser(db, userId),
  });

  app.post('/v1/auth/register', async (req, reply) => {
    if (!cfg.ALLOW_REGISTRATION)
      throw new AppError(
        403,
        'REGISTRATION_DISABLED',
        'Registration is disabled on this deployment',
      );
    throttle(`reg:${req.ip}`);
    const input = parse(registerSchema, req.body);
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await createUser(db, { email: input.email, name: input.name, passwordHash });
      await createWorkspace(db, { name: `${input.name}'s workspace`, ownerId: user.id });
      await startSession(reply, user.id);
      return reply.status(201).send(await me(user.id, user));
    } catch (error) {
      if (error instanceof EmailTakenError) {
        throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
      }
      throw error;
    }
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const input = parse(loginSchema, req.body);
    throttle(`ip:${req.ip}`);
    throttle(`email:${input.email.toLowerCase()}`);
    const record = await findUserByEmail(db, input.email);
    // Always run a full scrypt verification so response time does not reveal whether the email exists.
    const ok = await verifyPassword(input.password, record?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!record || !ok) {
      metrics.authFailures.inc({ kind: 'login' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Incorrect email or password');
    }
    await startSession(reply, record.id);
    return reply.send(
      await me(record.id, { id: record.id, email: record.email, name: record.name }),
    );
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, sha256Hex(token));
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/v1/me', async (req) => {
    const user = await requireUser(req, db);
    return me(user.id, user);
  });
}
