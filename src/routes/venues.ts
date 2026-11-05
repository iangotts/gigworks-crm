import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, type Deps } from '../auth.js';
import { withTenant } from '../db.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const text = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  city: text(100),
  address: text(300),
});

export function registerVenueRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/venues', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    if (!auth.tenantId || !auth.role) return reply.code(409).send({ error: 'no_active_tenant' });
    const { q } = z.object({ q: z.string().trim().max(200).optional() }).parse(req.query);
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const res = await withTenant(
      deps.pool,
      { userId: auth.userId, tenantId: auth.tenantId, role: auth.role },
      (c) =>
        c.query(
          `SELECT id, name, city FROM venue
            WHERE $1::text IS NULL OR concat_ws(' ', name, city) ILIKE $1
            ORDER BY lower(name) LIMIT 20`,
          [like],
        ),
    );
    return { venues: res.rows };
  });

  app.post('/api/venues', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    if (!auth.tenantId || !auth.role) return reply.code(409).send({ error: 'no_active_tenant' });
    if (auth.role === 'read_only') return reply.code(403).send({ error: 'read_only' });
    const b = createBody.parse(req.body);
    const res = await withTenant(
      deps.pool,
      { userId: auth.userId, tenantId: auth.tenantId, role: auth.role },
      (c) =>
        c.query(
          `INSERT INTO venue (tenant_id, name, city, address) VALUES ($1, $2, $3, $4)
           RETURNING id, name, city`,
          [auth.tenantId, b.name, b.city ?? null, b.address ?? null],
        ),
    );
    return reply.code(201).send(res.rows[0]);
  });
}
