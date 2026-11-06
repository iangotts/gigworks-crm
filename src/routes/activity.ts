import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withTenant } from '../db.js';
import { makeGuards } from './guard.js';

const KINDS = ['call', 'voicemail', 'text', 'email', 'note', 'task'] as const;
const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuidOrNull = z.preprocess(emptyToNull, z.string().uuid().nullable().optional());
const when = z.preprocess(emptyToNull, z.string().datetime({ offset: true }).nullable().optional());

const createBody = z.object({
  kind: z.enum(KINDS),
  contact_id: uuidOrNull,
  gig_id: uuidOrNull,
  body: z.string().trim().min(1).max(20000),
  occurred_at: when,
  due_at: when,
});
const updateBody = z
  .object({
    body: z.string().trim().min(1).max(20000).optional(),
    due_at: when,
    completed: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
const listQuery = z.object({ contact_id: z.string().uuid().optional(), gig_id: z.string().uuid().optional() });
const idParam = z.object({ id: z.string().uuid() });

export const ACTIVITY_SELECT = `
  SELECT a.id, a.kind, a.body, a.subject, a.email_to, a.delivery, a.delivery_error, a.occurred_at, a.due_at, a.completed_at, a.contact_id, a.gig_id,
         g.title AS gig_title,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
         u.name AS by_name
    FROM activity a
    LEFT JOIN gig g     ON g.tenant_id = a.tenant_id AND g.id = a.gig_id
    LEFT JOIN contact c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
    LEFT JOIN app_user u ON u.id = a.created_by`;

export function registerActivityRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);

  // The log for one contact or one gig, newest first.
  app.get('/api/activity', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const q = listQuery.parse(req.query);
    if (!q.contact_id && !q.gig_id) return reply.code(400).send({ error: 'needs_contact_or_gig' });
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `${ACTIVITY_SELECT}
          WHERE ($1::uuid IS NULL OR a.contact_id = $1) AND ($2::uuid IS NULL OR a.gig_id = $2)
          ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 200`,
        [q.contact_id ?? null, q.gig_id ?? null],
      ),
    );
    return { activity: res.rows };
  });

  app.post('/api/activity', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = createBody.parse(req.body);
    if (!b.contact_id && !b.gig_id) return reply.code(400).send({ error: 'needs_contact_or_gig' });
    if (b.kind !== 'task' && b.due_at) return reply.code(400).send({ error: 'only_tasks_have_due_date' });
    try {
      const out = await withTenant(deps.pool, ctx, async (c) => {
        // A note on a gig also belongs to the gig's contact, so the contact's log shows it.
        const ins = await c.query<{ id: string }>(
          `INSERT INTO activity (tenant_id, kind, contact_id, gig_id, body, occurred_at, due_at, created_by)
           VALUES ($1, $2,
                   COALESCE($3::uuid, (SELECT contact_id FROM gig WHERE id = $4::uuid)),
                   $4::uuid, $5, COALESCE($6::timestamptz, now()), $7::timestamptz, $8)
           RETURNING id`,
          [ctx.tenantId, b.kind, b.contact_id ?? null, b.gig_id ?? null, b.body, b.occurred_at ?? null, b.due_at ?? null, ctx.userId],
        );
        return c.query(`${ACTIVITY_SELECT} WHERE a.id = $1`, [(ins.rows[0] as { id: string }).id]);
      });
      return reply.code(201).send(out.rows[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23503') return reply.code(400).send({ error: 'unknown_contact_or_gig' });
      if (code === '42501') return reply.code(403).send({ error: 'read_only' });
      throw err;
    }
  });

  // Edit the text, or tick a task off (or back on).
  app.patch('/api/activity/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = updateBody.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (b.body !== undefined) { values.push(b.body); sets.push(`body = $${values.length}`); }
    if (b.due_at !== undefined) { values.push(b.due_at); sets.push(`due_at = $${values.length}::timestamptz`); }
    if (b.completed !== undefined) sets.push(`completed_at = ${b.completed ? 'now()' : 'NULL'}`);
    values.push(id);
    try {
      const out = await withTenant(deps.pool, ctx, async (c) => {
        // The record of an email we sent is not editable, so the log stays true to what went out.
        const lock = b.body !== undefined ? ' AND delivery IS NULL' : '';
        const r = await c.query(`UPDATE activity SET ${sets.join(', ')} WHERE id = $${values.length}${lock} RETURNING id`, values);
        if (r.rowCount === 0) {
          const exists = await c.query('SELECT 1 FROM activity WHERE id = $1', [id]);
          return exists.rows[0] ? 'locked' : null;
        }
        return c.query(`${ACTIVITY_SELECT} WHERE a.id = $1`, [id]);
      });
      if (!out) return reply.code(404).send({ error: 'not_found' });
      if (out === 'locked') return reply.code(409).send({ error: 'sent_email_locked' });
      return out.rows[0];
    } catch (err) {
      // The table only lets tasks carry a due date or a completed time.
      if ((err as { code?: string }).code === '23514') return reply.code(400).send({ error: 'only_tasks_have_due_date' });
      throw err;
    }
  });

  // Everything that needs doing: open tasks, gigs to chase, and replies owed.
  app.get('/api/followups', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const tasks = await c.query(
        `${ACTIVITY_SELECT} WHERE a.kind = 'task' AND a.completed_at IS NULL
          ORDER BY a.due_at NULLS LAST, a.created_at LIMIT 500`,
      );
      const open = `g.archived_at IS NULL AND g.stage NOT IN ('played', 'lost')`;
      const name = `nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')`;
      const gigs = await c.query(
        `SELECT g.id, g.title, g.stage, g.next_action_at, g.contact_id, ${name} AS contact_name
           FROM gig g LEFT JOIN contact c ON c.tenant_id = g.tenant_id AND c.id = g.contact_id
          WHERE ${open} AND g.next_action_at IS NOT NULL ORDER BY g.next_action_at LIMIT 500`,
      );
      const replies = await c.query(
        `SELECT g.id, g.title, g.stage, g.reply_owed_by, g.contact_id, ${name} AS contact_name
           FROM gig g LEFT JOIN contact c ON c.tenant_id = g.tenant_id AND c.id = g.contact_id
          WHERE ${open} AND g.reply_owed_by IS NOT NULL ORDER BY g.reply_owed_by LIMIT 500`,
      );
      return { tasks: tasks.rows, gigs: gigs.rows, replies: replies.rows };
    });
    return out;
  });
}
