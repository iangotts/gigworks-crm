import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withTenant } from '../db.js';
import { likePattern, makeGuards } from './guard.js';

const COLUMNS = `id, first_name, last_name, email, phone, company, job_title, source, notes, tags, created_at, updated_at`;

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const text = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

// Every column a user may set. Unknown keys, including any tenant_id, are dropped.
const fields = {
  first_name: text(200),
  last_name: text(200),
  email: z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(320).nullable().optional()),
  phone: text(60),
  company: text(200),
  job_title: text(200),
  address: text(500),
  city: text(200),
  source: text(100),
  notes: text(10000),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
};
const createBody = z.object(fields);
const updateBody = z
  .object({ ...fields, archived: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(60).optional(),
  sort: z.enum(['name', 'recent']).default('name'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const idParam = z.object({ id: z.string().uuid() });

const LIST_SQL = `
  SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.company, c.job_title, c.city, c.tags,
         c.created_at, c.updated_at,
         s.status AS subscription,
         (SELECT max(a.occurred_at) FROM activity a
           WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id AND a.kind <> 'task') AS last_contact_at,
         (SELECT count(*)::int FROM gig g
           WHERE g.tenant_id = c.tenant_id AND g.contact_id = c.id AND g.archived_at IS NULL
             AND g.stage NOT IN ('played', 'lost')) AS open_gigs
    FROM contact c
    LEFT JOIN subscription s ON s.tenant_id = c.tenant_id AND s.contact_id = c.id`;

export function registerContactRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);

  // Typed-ahead lookups (the gig form) use the same list with a small limit.
  app.get('/api/contacts', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const query = listQuery.parse(req.query);
    const order =
      query.sort === 'recent'
        ? 'last_contact_at DESC NULLS LAST, lower(c.last_name) NULLS LAST'
        : 'lower(c.last_name) NULLS LAST, lower(c.first_name) NULLS LAST, c.created_at';
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `SELECT * FROM (${LIST_SQL}
          WHERE c.archived_at IS NULL
            AND ($1::text IS NULL
                 OR concat_ws(' ', c.first_name, c.last_name, c.email, c.company, c.phone) ILIKE $1)
            AND ($2::text IS NULL OR $2 = ANY (c.tags))) c
          ORDER BY ${order}
          LIMIT $3 OFFSET $4`,
        [likePattern(query.q), query.tag ?? null, query.limit, query.offset],
      ),
    );
    return { contacts: res.rows };
  });

  // Every tag in use, for the filter.
  app.get('/api/contacts/tags', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query<{ tag: string; n: number }>(
        `SELECT t AS tag, count(*)::int AS n FROM contact, unnest(tags) t
          WHERE archived_at IS NULL GROUP BY t ORDER BY n DESC, t LIMIT 100`,
      ),
    );
    return { tags: res.rows };
  });

  app.get('/api/contacts/:id', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const contact = await c.query(`${LIST_SQL} WHERE c.id = $1 AND c.archived_at IS NULL`, [id]);
      if (contact.rowCount === 0) return null;
      const full = await c.query(`SELECT address, source, notes, is_local FROM contact WHERE id = $1`, [id]);
      const sub = await c.query(
        `SELECT status, consent_source, consented_at, unsubscribed_at FROM subscription WHERE contact_id = $1`, [id]);
      const gigs = await c.query(
        `SELECT id, title, stage, postponed, event_date FROM gig
          WHERE contact_id = $1 AND archived_at IS NULL
          ORDER BY event_date DESC NULLS FIRST, created_at DESC LIMIT 50`,
        [id],
      );
      return { contact: { ...contact.rows[0], ...full.rows[0], consent: sub.rows[0] ?? null }, gigs: gigs.rows };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/api/contacts', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = createBody.parse(req.body);
    try {
      const res = await withTenant(deps.pool, ctx, (c) =>
        c.query(
          `INSERT INTO contact
             (tenant_id, first_name, last_name, email, phone, company, job_title, address, city, source, notes, tags, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${COLUMNS}`,
          [
            ctx.tenantId, b.first_name ?? null, b.last_name ?? null, b.email ?? null, b.phone ?? null,
            b.company ?? null, b.job_title ?? null, b.address ?? null, b.city ?? null, b.source ?? null,
            b.notes ?? null, b.tags ?? [], ctx.userId,
          ],
        ),
      );
      return reply.code(201).send(res.rows[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') return reply.code(409).send({ error: 'email_exists' });
      if (code === '42501') return reply.code(403).send({ error: 'read_only' });
      throw err;
    }
  });

  app.patch('/api/contacts/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const { archived, ...rest } = updateBody.parse(req.body);
    // Column names come only from the whitelist above, never from the request.
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${k} = $${values.length}`);
    }
    if (archived !== undefined) sets.push(`archived_at = ${archived ? 'now()' : 'NULL'}`);
    values.push(id);
    try {
      const res = await withTenant(deps.pool, ctx, (c) =>
        c.query(`UPDATE contact SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`, values),
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') return reply.code(409).send({ error: 'email_exists' });
      throw err;
    }
    const out = await withTenant(deps.pool, ctx, (c) => c.query(`${LIST_SQL} WHERE c.id = $1`, [id]));
    return out.rows[0];
  });
}
