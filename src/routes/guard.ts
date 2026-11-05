import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, type Deps } from '../auth.js';
import type { TenantContext } from '../db.js';

/** Logged in and working in a band, or an error reply and null. */
export function makeGuards(deps: Deps) {
  const needTenant = async (req: FastifyRequest, reply: FastifyReply): Promise<TenantContext | null> => {
    const auth = await authenticate(deps, req);
    if (!auth) {
      void reply.code(401).send({ error: 'not_logged_in' });
      return null;
    }
    if (!auth.tenantId || !auth.role) {
      void reply.code(409).send({ error: 'no_active_tenant' });
      return null;
    }
    return { userId: auth.userId, tenantId: auth.tenantId, role: auth.role };
  };

  // Read-only members are stopped here with a plain message. The database refuses them too.
  const needWrite = async (req: FastifyRequest, reply: FastifyReply): Promise<TenantContext | null> => {
    const ctx = await needTenant(req, reply);
    if (ctx && ctx.role === 'read_only') {
      void reply.code(403).send({ error: 'read_only' });
      return null;
    }
    return ctx;
  };

  return { needTenant, needWrite };
}

export const likePattern = (q: string | undefined): string | null =>
  q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
