import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { CalendarService } from '../calendar.js';
import { authenticate, type Deps } from '../auth.js';
import { withTenant, type TenantContext } from '../db.js';

export const STAGES = ['new', 'evaluating', 'in_conversation', 'confirmed', 'played', 'lost'] as const;
const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  new: 'New',
  evaluating: 'Evaluating',
  in_conversation: 'In conversation',
  confirmed: 'Confirmed',
  played: 'Played',
  lost: 'Lost',
};

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const text = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable());
const num = z.preprocess(emptyToNull, z.coerce.number().finite().nonnegative().max(99999999).nullable());
const date = z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable());
const time = z.preprocess(emptyToNull, z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').nullable());
const uuidOrNull = z.preprocess(emptyToNull, z.string().uuid().nullable());

// Every column a user may set. Anything else in a request body is dropped, tenant_id included.
const fields = {
  title: z.string().trim().min(1).max(300),
  stage: z.enum(STAGES),
  postponed: z.boolean(),
  lost_reason: text(500),
  contact_id: uuidOrNull,
  venue_id: uuidOrNull,
  event_date: date,
  load_in_time: time,
  start_time: time,
  end_time: time,
  event_type: text(100),
  platform: text(100),
  lead_url: z.preprocess(emptyToNull, z.string().trim().url().max(2000).nullable()),
  indoor_outdoor: z.preprocess(emptyToNull, z.enum(['indoor', 'outdoor', 'both']).nullable()),
  hours: num,
  budget: num,
  verified_phone: z.boolean(),
  credits_spent: z.coerce.number().int().min(0).max(1000),
  drive_miles: num,
  band_pitched: text(200),
  decision: z.preprocess(emptyToNull, z.enum(['pursue', 'decline']).nullable()),
  decline_reason: text(500),
  next_action_at: z.preprocess(emptyToNull, z.string().datetime({ offset: true }).nullable()),
  reply_owed_by: date,
  fee_quoted: num,
  fee_note: text(500),
  tag: text(100),
  notes: text(20000),
  archived: z.boolean(),
};

const createBody = z.object(fields).partial().extend({ title: fields.title }).omit({ archived: true });
const updateBody = z
  .object(fields)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

const LIST_SQL = `
  SELECT g.id, g.title, g.stage, g.postponed, g.event_date, g.start_time, g.event_type, g.platform,
         g.budget, g.fee_quoted, g.fee_note, g.next_action_at, g.reply_owed_by, g.decision,
         g.contact_id, g.venue_id, g.updated_at,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
         v.name AS venue_name,
         m.state AS pay_state, m.received::text AS received, m.outstanding::text AS outstanding
    FROM gig g
    LEFT JOIN contact c ON c.tenant_id = g.tenant_id AND c.id = g.contact_id
    LEFT JOIN venue v   ON v.tenant_id = g.tenant_id AND v.id = g.venue_id
    LEFT JOIN gig_money m ON m.gig_id = g.id`;

const DETAIL_SQL = `
  SELECT g.*,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
         c.email AS contact_email, c.phone AS contact_phone,
         v.name AS venue_name, v.city AS venue_city
    FROM gig g
    LEFT JOIN contact c ON c.tenant_id = g.tenant_id AND c.id = g.contact_id
    LEFT JOIN venue v   ON v.tenant_id = g.tenant_id AND v.id = g.venue_id
   WHERE g.id = $1`;

const idParam = z.object({ id: z.string().uuid() });

export function registerGigRoutes(app: FastifyInstance, deps: Deps, calendar: CalendarService | null = null): void {
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

  const needWrite = async (req: FastifyRequest, reply: FastifyReply): Promise<TenantContext | null> => {
    const ctx = await needTenant(req, reply);
    if (ctx && ctx.role === 'read_only') {
      void reply.code(403).send({ error: 'read_only' });
      return null;
    }
    return ctx;
  };

  // A contact or venue id must belong to this tenant. The composite foreign key enforces it too,
  // this gives a readable error first.
  const fkError = (err: unknown): { error: string } | null => {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23503') return { error: 'unknown_contact_or_venue' };
    return null;
  };

  app.get('/api/gigs', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const { q } = z.object({ q: z.string().trim().max(200).optional() }).parse(req.query);
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `${LIST_SQL}
          WHERE g.archived_at IS NULL
            AND ($1::text IS NULL
                 OR concat_ws(' ', g.title, v.name, c.first_name, c.last_name, g.event_type, g.platform) ILIKE $1)
          ORDER BY g.event_date NULLS LAST, g.created_at DESC
          LIMIT 2000`,
        [like],
      ),
    );
    return { gigs: res.rows };
  });

  app.get('/api/gigs/:id', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const gig = await c.query(DETAIL_SQL, [id]);
      if (!gig.rows[0]) return null;
      const activity = await c.query(
        `SELECT id, kind, body, occurred_at, due_at, completed_at
           FROM activity WHERE gig_id = $1 ORDER BY occurred_at DESC LIMIT 100`,
        [id],
      );
      return { gig: gig.rows[0], activity: activity.rows };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/api/gigs', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = createBody.parse(req.body);
    if (b.postponed && (b.stage ?? 'new') !== 'confirmed') {
      return reply.code(400).send({ error: 'postponed_needs_confirmed' });
    }
    const cols = Object.keys(b) as (keyof typeof b)[];
    const values = cols.map((k) => b[k]);
    const sql = `INSERT INTO gig (tenant_id, created_by${cols.map((k) => `, ${k}`).join('')})
                 VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`;
    try {
      const out = await withTenant(deps.pool, ctx, async (c) => {
        const ins = await c.query<{ id: string }>(sql, [ctx.tenantId, ctx.userId, ...values]);
        const id = (ins.rows[0] as { id: string }).id;
        const row = await c.query(`${LIST_SQL} WHERE g.id = $1`, [id]);
        return row.rows[0];
      });
      // A gig can be created already confirmed. Never let a calendar problem fail the save.
      await calendar?.sync(ctx, (out as { id: string }).id);
      return reply.code(201).send(out);
    } catch (err) {
      const e = fkError(err);
      if (e) return reply.code(400).send(e);
      throw err;
    }
  });

  app.patch('/api/gigs/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = updateBody.parse(req.body);
    try {
      const out = await withTenant(deps.pool, ctx, async (c): Promise<{ row?: unknown; error?: string }> => {
        const cur = await c.query<{ stage: (typeof STAGES)[number]; postponed: boolean }>(
          'SELECT stage, postponed FROM gig WHERE id = $1 FOR UPDATE',
          [id],
        );
        const before = cur.rows[0];
        if (!before) return { error: 'not_found' };

        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b)) {
          if (v === undefined || k === 'archived') continue;
          set[k] = v;
        }
        if (b.archived !== undefined) set.archived_at = b.archived ? new Date().toISOString() : null;

        const stage = b.stage ?? before.stage;
        // Leaving confirmed clears postponed. Setting postponed on a gig that is not confirmed is an error.
        if (stage !== 'confirmed') {
          if (b.postponed === true) return { error: 'postponed_needs_confirmed' };
          if (before.postponed) set.postponed = false;
        }
        if (stage !== 'lost' && b.stage !== undefined && b.lost_reason === undefined) set.lost_reason = null;

        const cols = Object.keys(set);
        if (cols.length > 0) {
          await c.query(`UPDATE gig SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [
            id,
            ...cols.map((k) => set[k]),
          ]);
        }
        if (b.stage !== undefined && b.stage !== before.stage) {
          await logStageChange(c, ctx, id, before.stage, b.stage);
          if (b.stage === 'played') await askForTestimonial(c, ctx, id);
        }
        const row = await c.query(`${LIST_SQL} WHERE g.id = $1`, [id]);
        return { row: row.rows[0] };
      });
      if (out.error === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (out.error) return reply.code(400).send({ error: out.error });
      // Keep the calendar event in step. A problem is recorded on the gig and never fails the save.
      await calendar?.sync(ctx, id);
      return out.row;
    } catch (err) {
      const e = fkError(err);
      if (e) return reply.code(400).send(e);
      throw err;
    }
  });

  // After the gig, a reminder to ask the client for a testimonial. Once per gig, however often the stage flips.
  async function askForTestimonial(c: pg.PoolClient, ctx: TenantContext, gigId: string): Promise<void> {
    await c.query(
      `INSERT INTO activity (tenant_id, kind, gig_id, contact_id, body, due_at, created_by)
       SELECT g.tenant_id, 'task', g.id, g.contact_id,
              'Ask ' || coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), 'the client') || ' for a testimonial',
              now() + interval '2 days', $2
         FROM gig g JOIN contact ct ON ct.tenant_id = g.tenant_id AND ct.id = g.contact_id
        WHERE g.id = $1
          AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.gig_id = g.id AND a.kind = 'task' AND a.body LIKE 'Ask % for a testimonial')`,
      [gigId, ctx.userId],
    );
  }

  // A short note when a gig moves, so the history shows how it got here.
  async function logStageChange(
    c: pg.PoolClient,
    ctx: TenantContext,
    gigId: string,
    from: (typeof STAGES)[number],
    to: (typeof STAGES)[number],
  ): Promise<void> {
    await c.query(
      `INSERT INTO activity (tenant_id, kind, gig_id, body, created_by) VALUES ($1, 'note', $2, $3, $4)`,
      [ctx.tenantId, gigId, `Stage changed: ${STAGE_LABEL[from]} to ${STAGE_LABEL[to]}`, ctx.userId],
    );
  }
}
