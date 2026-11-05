import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, COOKIE_NAME, type Deps } from '../auth.js';
import { withAnonymous, withUser, type Role } from '../db.js';
import { dummyHash, verifyPassword } from '../passwords.js';
import { createSession, deleteSession, setSessionTenant } from '../sessions.js';

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320),
  password: z.string().min(1).max(500),
});
const tenantBody = z.object({ tenantId: z.string().uuid() });

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

async function listTenants(deps: Deps, userId: string): Promise<TenantRow[]> {
  const res = await withUser(deps.pool, userId, (c) =>
    c.query<TenantRow>(
      `SELECT t.id, t.name, t.slug, m.role
         FROM membership m JOIN tenant t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY t.name`,
      [userId],
    ),
  );
  return res.rows;
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps, loginLimit: number): void {
  const setCookie = (reply: FastifyReply, token: string): void => {
    void reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.cookieSecure,
      path: '/',
      maxAge: deps.config.sessionDays * 24 * 60 * 60,
    });
  };

  app.post(
    '/api/login',
    { config: { rateLimit: { max: loginLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const found = await withAnonymous(deps.pool, (c) =>
        c.query<{ id: string; email: string; name: string | null; password_hash: string | null; is_active: boolean }>(
          'SELECT * FROM auth_lookup($1)',
          [body.email],
        ),
      );
      const user = found.rows[0];
      // Always do one password check, so unknown emails, disabled users and wrong passwords
      // look and feel the same.
      const stored = user?.password_hash ?? (await dummyHash(deps.config.scryptLogN));
      const ok = await verifyPassword(body.password, stored);
      if (!user || !user.is_active || !user.password_hash || !ok) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const tenants = await listTenants(deps, user.id);
      // One band: go straight in. Two or more: the user picks.
      const active = tenants.length === 1 ? (tenants[0] as TenantRow) : null;
      const token = await createSession(deps.pool, user.id, active?.id ?? null, deps.config.sessionDays);
      setCookie(reply, token);
      return {
        user: { id: user.id, email: user.email, name: user.name },
        tenants,
        activeTenantId: active?.id ?? null,
      };
    },
  );

  app.post('/api/logout', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (auth) await deleteSession(deps.pool, auth.sessionId);
    void reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    const [tenants, me] = await Promise.all([
      listTenants(deps, auth.userId),
      withUser(deps.pool, auth.userId, (c) =>
        c.query<{ id: string; email: string; name: string | null }>(
          'SELECT id, email, name FROM app_user WHERE id = $1',
          [auth.userId],
        ),
      ),
    ]);
    return { user: me.rows[0], tenants, activeTenantId: auth.tenantId, role: auth.role };
  });

  // Choose which band to work in. The membership is checked here, and again on every request.
  app.post('/api/session/tenant', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    const { tenantId } = tenantBody.parse(req.body);
    const tenants = await listTenants(deps, auth.userId);
    const chosen = tenants.find((t) => t.id === tenantId);
    if (!chosen) return reply.code(403).send({ error: 'not_a_member' });
    await setSessionTenant(deps.pool, auth.sessionId, chosen.id);
    return { activeTenantId: chosen.id, role: chosen.role };
  });
}
