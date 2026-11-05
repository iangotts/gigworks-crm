import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withTenant } from '../db.js';
import { makeGuards } from './guard.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['decline', 'pitch', 'follow_up', 'other']),
  subject: z.preprocess(emptyToNull, z.string().trim().max(300).nullable()),
  body: z.string().trim().min(1).max(20000),
  archived: z.boolean(),
};
const createBody = z.object({ name: fields.name, kind: fields.kind.default('other'), subject: fields.subject.optional(), body: fields.body });
const updateBody = z
  .object(fields)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
const idParam = z.object({ id: z.string().uuid() });
const COLUMNS = 'id, name, kind, subject, body, updated_at';

export function registerTemplateRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);

  app.get('/api/templates', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(`SELECT ${COLUMNS} FROM template WHERE archived_at IS NULL ORDER BY kind, lower(name)`),
    );
    return { templates: res.rows };
  });

  app.post('/api/templates', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = createBody.parse(req.body);
    try {
      const res = await withTenant(deps.pool, ctx, (c) =>
        c.query(
          `INSERT INTO template (tenant_id, name, kind, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
          [ctx.tenantId, b.name, b.kind, b.subject ?? null, b.body],
        ),
      );
      return reply.code(201).send(res.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'template_name_exists' });
      throw err;
    }
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const { archived, ...rest } = updateBody.parse(req.body);
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
        c.query(`UPDATE template SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`, values),
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return res.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'template_name_exists' });
      throw err;
    }
  });
}
