import { z } from 'zod';
import { authenticate } from '../auth.js';
import { withTenant } from '../db.js';
const COLUMNS = `id, first_name, last_name, email, phone, company, job_title, source, notes, tags, created_at, updated_at`;
const emptyToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const text = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
// Unknown keys, including any tenant_id, are dropped. The tenant always comes from the session.
const createBody = z.object({
    first_name: text(200),
    last_name: text(200),
    email: z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(320).nullable().optional()),
    phone: text(60),
    company: text(200),
    job_title: text(200),
    source: text(100),
    notes: text(10000),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});
const listQuery = z.object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
export function registerContactRoutes(app, deps) {
    // Logged in and working in a tenant, or an error reply. Returns the tenant context.
    const needTenant = async (req, reply) => {
        const auth = await authenticate(deps, req);
        if (!auth) {
            reply.code(401).send({ error: 'not_logged_in' });
            return null;
        }
        if (!auth.tenantId || !auth.role) {
            reply.code(409).send({ error: 'no_active_tenant' });
            return null;
        }
        return { auth, ctx: { userId: auth.userId, tenantId: auth.tenantId, role: auth.role } };
    };
    app.get('/api/contacts', async (req, reply) => {
        const got = await needTenant(req, reply);
        if (!got)
            return reply;
        const query = listQuery.parse(req.query);
        const like = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
        const res = await withTenant(deps.pool, got.ctx, (c) => c.query(`SELECT ${COLUMNS} FROM contact
          WHERE archived_at IS NULL
            AND ($1::text IS NULL
                 OR concat_ws(' ', first_name, last_name, email, company) ILIKE $1)
          ORDER BY lower(last_name) NULLS LAST, lower(first_name) NULLS LAST, created_at
          LIMIT $2 OFFSET $3`, [like, query.limit, query.offset]));
        return { contacts: res.rows };
    });
    app.post('/api/contacts', async (req, reply) => {
        const got = await needTenant(req, reply);
        if (!got)
            return reply;
        const b = createBody.parse(req.body);
        try {
            const res = await withTenant(deps.pool, got.ctx, (c) => c.query(`INSERT INTO contact
             (tenant_id, first_name, last_name, email, phone, company, job_title, source, notes, tags, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${COLUMNS}`, [
                got.ctx.tenantId,
                b.first_name ?? null,
                b.last_name ?? null,
                b.email ?? null,
                b.phone ?? null,
                b.company ?? null,
                b.job_title ?? null,
                b.source ?? null,
                b.notes ?? null,
                b.tags ?? [],
                got.ctx.userId,
            ]));
            return reply.code(201).send(res.rows[0]);
        }
        catch (err) {
            const code = err.code;
            if (code === '23505')
                return reply.code(409).send({ error: 'email_exists' });
            if (code === '42501')
                return reply.code(403).send({ error: 'read_only' });
            throw err;
        }
    });
}
