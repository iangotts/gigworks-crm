import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withTenant, type TenantContext } from '../db.js';
import { makeGuards } from './guard.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
// Amounts travel as text like "1250.50" so no float ever touches them. The database adds them up.
const amount = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z
    .string()
    .trim()
    .regex(/^\d{1,8}(\.\d{1,2})?$/, 'Use dollars and cents, like 1250.50')
    .refine((s) => Number(s) > 0, 'Must be more than zero'),
);
const date = z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable());
const text = (n: number) => z.preprocess(emptyToNull, z.string().trim().max(n).nullable());
const KINDS = ['deposit', 'balance', 'other'] as const;

const createBody = z.object({ kind: z.enum(KINDS), amount, due_on: date.optional(), paid_on: date.optional(), method: text(60).optional(), note: text(500).optional() });
const updateBody = z
  .object({ kind: z.enum(KINDS), amount, due_on: date, paid_on: date, method: text(60), note: text(500) })
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
const planBody = z.object({
  deposit_percent: z.coerce.number().int().min(1).max(99).default(50),
  deposit_due_on: date.optional(),
  balance_due_on: date.optional(),
});
const idParam = z.object({ id: z.string().uuid() });

const COLUMNS = 'id, gig_id, kind, amount::text AS amount, due_on, paid_on, method, note';
const MONEY = 'fee::text AS fee, scheduled::text AS scheduled, received::text AS received, outstanding::text AS outstanding, state, schedule_gap::text AS schedule_gap';

/** A day or so ahead is allowed, so a payment taken this evening is not "in the future" in another time zone. */
const latestPaidDate = (): string => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const dollars = (s: string): string => `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const KIND_LABEL = { deposit: 'Deposit', balance: 'Balance', other: 'Payment' } as const;

async function note(c: pg.PoolClient, ctx: TenantContext, gigId: string, body: string): Promise<void> {
  await c.query(
    `INSERT INTO activity (tenant_id, kind, gig_id, contact_id, body, created_by)
     VALUES ($1, 'note', $2, (SELECT contact_id FROM gig WHERE id = $2), $3, $4)`,
    [ctx.tenantId, gigId, body, ctx.userId],
  );
}

export function registerPaymentRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);

  const moneyFor = async (c: pg.PoolClient, gigId: string) => {
    const m = await c.query(`SELECT ${MONEY} FROM gig_money WHERE gig_id = $1`, [gigId]);
    if (!m.rows[0]) return null;
    const p = await c.query(`SELECT ${COLUMNS} FROM payment WHERE gig_id = $1 ORDER BY paid_on NULLS LAST, due_on NULLS LAST, created_at`, [gigId]);
    return { ...m.rows[0], payments: p.rows };
  };
  const liveGig = async (c: pg.PoolClient, gigId: string): Promise<'ok' | 'missing' | 'archived'> => {
    const g = await c.query<{ archived_at: string | null }>('SELECT archived_at FROM gig WHERE id = $1', [gigId]);
    return !g.rows[0] ? 'missing' : g.rows[0].archived_at ? 'archived' : 'ok';
  };

  app.get('/api/gigs/:id/money', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const out = await withTenant(deps.pool, ctx, (c) => moneyFor(c, id));
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/api/gigs/:id/payments', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = createBody.parse(req.body);
    if (b.paid_on && b.paid_on > latestPaidDate()) return reply.code(400).send({ error: 'paid_in_future' });
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const g = await liveGig(c, id);
      if (g !== 'ok') return { error: g === 'missing' ? 'not_found' : 'gig_archived' };
      await c.query(
        `INSERT INTO payment (tenant_id, gig_id, kind, amount, due_on, paid_on, method, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.tenantId, id, b.kind, b.amount, b.due_on ?? null, b.paid_on ?? null, b.method ?? null, b.note ?? null],
      );
      if (b.paid_on) await note(c, ctx, id, `${KIND_LABEL[b.kind]} ${dollars(b.amount)} received${b.method ? ` by ${b.method}` : ''}`);
      return { money: await moneyFor(c, id) };
    });
    if ('error' in out) return reply.code(out.error === 'not_found' ? 404 : 409).send({ error: out.error });
    return reply.code(201).send(out.money);
  });

  // Splits the fee into a deposit and a balance that add up to it exactly.
  app.post('/api/gigs/:id/payments/plan', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = planBody.parse(req.body ?? {});
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const g = await c.query<{ archived_at: string | null; fee_quoted: string | null; event_date: string | null }>('SELECT archived_at, fee_quoted::text, event_date FROM gig WHERE id = $1 FOR UPDATE', [id]);
      const gig = g.rows[0];
      if (!gig) return { error: 'not_found' };
      if (gig.archived_at) return { error: 'gig_archived' };
      if (!gig.fee_quoted || Number(gig.fee_quoted) <= 0) return { error: 'no_fee' };
      const has = await c.query('SELECT 1 FROM payment WHERE gig_id = $1 LIMIT 1', [id]);
      if (has.rows[0]) return { error: 'payments_exist' };
      // Rounded once, in numeric. The balance is whatever is left, so the two always sum to the fee.
      const split = (await c.query<{ deposit: string; balance: string }>(
        `SELECT round(fee * $2 / 100, 2)::text AS deposit, (fee - round(fee * $2 / 100, 2))::text AS balance FROM (SELECT $1::numeric AS fee) f`,
        [gig.fee_quoted, b.deposit_percent],
      )).rows[0] as { deposit: string; balance: string };
      await c.query(
        `INSERT INTO payment (tenant_id, gig_id, kind, amount, due_on) VALUES ($1, $2, 'deposit', $3, $4), ($1, $2, 'balance', $5, $6)`,
        [ctx.tenantId, id, split.deposit, b.deposit_due_on ?? null, split.balance, b.balance_due_on ?? gig.event_date],
      );
      await note(c, ctx, id, `Payment plan: deposit ${dollars(split.deposit)}, balance ${dollars(split.balance)}`);
      return { money: await moneyFor(c, id) };
    });
    if ('error' in out) return reply.code(out.error === 'not_found' ? 404 : 409).send({ error: out.error });
    return reply.code(201).send(out.money);
  });

  app.patch('/api/payments/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = updateBody.parse(req.body);
    if (b.paid_on && b.paid_on > latestPaidDate()) return reply.code(400).send({ error: 'paid_in_future' });
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const cur = (await c.query<{ gig_id: string; kind: (typeof KINDS)[number]; amount: string; paid_on: string | null }>('SELECT gig_id, kind, amount::text, paid_on FROM payment WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) return { error: 'not_found' };
      if ((await liveGig(c, cur.gig_id)) !== 'ok') return { error: 'gig_archived' };
      const set: string[] = [];
      const values: unknown[] = [id];
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined) continue;
        values.push(v);
        set.push(`${k} = $${values.length}`);
      }
      await c.query(`UPDATE payment SET ${set.join(', ')} WHERE id = $1`, values);
      const kind = b.kind ?? cur.kind;
      const amt = b.amount ?? cur.amount;
      if (b.paid_on !== undefined && b.paid_on !== cur.paid_on) {
        await note(c, ctx, cur.gig_id, b.paid_on ? `${KIND_LABEL[kind]} ${dollars(amt)} marked paid` : `${KIND_LABEL[kind]} ${dollars(amt)} marked not paid`);
      }
      return { money: await moneyFor(c, cur.gig_id) };
    });
    if ('error' in out) return reply.code(out.error === 'not_found' ? 404 : 409).send({ error: out.error });
    return out.money;
  });

  // Only a payment that has not been received can be removed. A received one must first be marked not paid, which is logged.
  app.delete('/api/payments/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const cur = (await c.query<{ gig_id: string; paid_on: string | null }>('SELECT gig_id, paid_on FROM payment WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) return { error: 'not_found' };
      if (cur.paid_on) return { error: 'paid_locked' };
      if ((await liveGig(c, cur.gig_id)) !== 'ok') return { error: 'gig_archived' };
      await c.query('DELETE FROM payment WHERE id = $1', [id]);
      return { money: await moneyFor(c, cur.gig_id) };
    });
    if ('error' in out) return reply.code(out.error === 'not_found' ? 404 : 409).send({ error: out.error });
    return out.money;
  });
}
