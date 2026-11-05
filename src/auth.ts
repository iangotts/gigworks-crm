import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { withUser, type Role } from './db.js';
import { getSession, setSessionTenant } from './sessions.js';

export const COOKIE_NAME = 'gwcrm_session';

export interface Deps {
  pool: pg.Pool;
  config: Config;
}

export interface Auth {
  sessionId: string;
  userId: string;
  /** The tenant being worked in, or null until one is chosen. */
  tenantId: string | null;
  /** The role in that tenant, read fresh from the database on every request. */
  role: Role | null;
}

/**
 * Who is making this request. Returns null when there is no valid session.
 * The role is looked up every time, so removing a member or changing their role
 * takes effect on their very next request.
 */
export async function authenticate(deps: Deps, req: FastifyRequest): Promise<Auth | null> {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  const session = await getSession(deps.pool, token, deps.config.sessionDays);
  if (!session) return null;

  let tenantId = session.tenantId;
  let role: Role | null = null;
  if (tenantId) {
    const found = tenantId;
    const res = await withUser(deps.pool, session.userId, (c) =>
      c.query<{ role: Role }>('SELECT role FROM membership WHERE tenant_id = $1 AND user_id = $2', [
        found,
        session.userId,
      ]),
    );
    role = res.rows[0]?.role ?? null;
    if (!role) {
      // They were removed from that tenant since they chose it.
      await setSessionTenant(deps.pool, session.id, null);
      tenantId = null;
    }
  }
  return { sessionId: session.id, userId: session.userId, tenantId, role };
}
