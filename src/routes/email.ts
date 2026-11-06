import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import type { Config } from '../config.js';
import { withTenant } from '../db.js';
import { EmailError, oneLine, type EmailProvider } from '../email.js';
import { ACTIVITY_SELECT } from './activity.js';
import { makeGuards } from './guard.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const address = z.string().trim().toLowerCase().max(254).regex(/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/, 'Not an email address');

const settingsBody = z.object({
  from_name: z.string().trim().min(1).max(100).regex(/^[^\r\n<>"]+$/, 'No quotes, brackets or line breaks'),
  from_email: address,
  reply_to: address,
  signature: z.preprocess(emptyToNull, z.string().trim().max(1000).nullable().optional()),
});
const sendBody = z.object({
  contact_id: z.string().uuid(),
  gig_id: z.preprocess(emptyToNull, z.string().uuid().nullable().optional()),
  subject: z.string().max(200).transform(oneLine).pipe(z.string().min(1)),
  body: z.string().trim().min(1).max(20000),
  request_id: z.string().uuid(),
  confirm_unsubscribed: z.boolean().optional(),
});

// A merge field nobody filled in must never reach a real person.
const UNFILLED = /\{(first_name|name|band|gig)\}/;

interface Settings {
  from_name: string;
  from_email: string;
  reply_to: string;
  signature: string | null;
}

export function registerEmailRoutes(app: FastifyInstance, deps: Deps, provider: EmailProvider): void {
  const { needTenant, needWrite } = makeGuards(deps);
  const config: Config = deps.config;
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.get('/api/email/settings', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query<Settings>('SELECT from_name, from_email, reply_to, signature FROM email_settings WHERE tenant_id = $1', [ctx.tenantId]),
    );
    const s = res.rows[0] ?? null;
    return { settings: s, provider: config.emailProvider, can_send: s !== null && config.emailProvider !== 'none' };
  });

  app.put('/api/email/settings', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });
    const b = settingsBody.parse(req.body);
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query<Settings>(
        `INSERT INTO email_settings (tenant_id, from_name, from_email, reply_to, signature)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE
           SET from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email,
               reply_to = EXCLUDED.reply_to, signature = EXCLUDED.signature
         RETURNING from_name, from_email, reply_to, signature`,
        [ctx.tenantId, b.from_name, b.from_email, b.reply_to, b.signature ?? null],
      ),
    );
    return res.rows[0];
  });

  // Sends a test to the logged-in person's own address, so nobody else is ever emailed by accident.
  app.post('/api/email/test', limit(5), async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    if (config.emailProvider === 'none') return reply.code(503).send({ error: 'email_not_configured' });
    const got = await withTenant(deps.pool, ctx, async (c) => {
      const s = await c.query<Settings>('SELECT from_name, from_email, reply_to, signature FROM email_settings WHERE tenant_id = $1', [ctx.tenantId]);
      const u = await c.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [ctx.userId]);
      const t = await c.query<{ name: string }>('SELECT name FROM tenant WHERE id = $1', [ctx.tenantId]);
      return { s: s.rows[0], to: u.rows[0]?.email, band: t.rows[0]?.name ?? '' };
    });
    if (!got.s) return reply.code(409).send({ error: 'email_not_set_up' });
    if (!got.to) return reply.code(409).send({ error: 'no_email' });
    try {
      await provider.send({
        fromName: got.s.from_name,
        fromEmail: got.s.from_email,
        replyTo: got.s.reply_to,
        to: got.to,
        subject: `Test from GW-CRM for ${oneLine(got.band)}`,
        text: `This is a test from GW-CRM.\n\nIt was sent as ${got.s.from_name} <${got.s.from_email}>. If you reply, the reply goes to ${got.s.reply_to}.`,
      });
    } catch (err) {
      if (!(err instanceof EmailError)) throw err;
      return reply.code(502).send({ error: 'send_failed', message: err.message });
    }
    return { ok: true, sent_to: got.to };
  });

  app.post('/api/email/send', limit(30), async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = sendBody.parse(req.body);
    if (UNFILLED.test(b.subject) || UNFILLED.test(b.body)) return reply.code(400).send({ error: 'unfilled_placeholder' });
    if (config.emailProvider === 'none') return reply.code(503).send({ error: 'email_not_configured' });

    type Pre =
      | { error: string; status: number }
      | { existing: unknown }
      | { id: string; mail: Parameters<EmailProvider['send']>[0] };
    const pre = await withTenant(deps.pool, ctx, async (c): Promise<Pre> => {
      // The same request id returns what happened the first time and never sends again.
      const dupe = await c.query(`${ACTIVITY_SELECT} WHERE a.request_id = $1`, [b.request_id]);
      if (dupe.rows[0]) return { existing: dupe.rows[0] };
      const s = (await c.query<Settings>('SELECT from_name, from_email, reply_to, signature FROM email_settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
      if (!s) return { error: 'email_not_set_up', status: 409 };
      const ct = (
        await c.query<{ email: string | null; archived_at: string | null; status: string | null }>(
          `SELECT c.email, c.archived_at,
                  (SELECT s.status FROM subscription s WHERE s.tenant_id = c.tenant_id AND s.contact_id = c.id) AS status
             FROM contact c WHERE c.id = $1`,
          [b.contact_id],
        )
      ).rows[0];
      if (!ct || ct.archived_at) return { error: 'contact_not_found', status: 404 };
      if (!ct.email) return { error: 'no_email', status: 409 };
      if (ct.status === 'bounced' || ct.status === 'suppressed') return { error: 'address_blocked', status: 409 };
      if (ct.status === 'unsubscribed' && !b.confirm_unsubscribed) return { error: 'unsubscribed', status: 409 };
      if (b.gig_id) {
        const g = await c.query('SELECT 1 FROM gig WHERE id = $1 AND archived_at IS NULL', [b.gig_id]);
        if (!g.rows[0]) return { error: 'gig_not_found', status: 404 };
      }
      const used = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM activity WHERE kind = 'email' AND delivery <> 'failed' AND created_at > now() - interval '24 hours'",
      );
      if ((used.rows[0]?.n ?? 0) >= config.emailDailyCap) return { error: 'daily_limit', status: 429 };
      const text = s.signature ? `${b.body}\n\n${s.signature}` : b.body;
      const ins = await c.query<{ id: string }>(
        `INSERT INTO activity (tenant_id, kind, contact_id, gig_id, body, subject, email_to, delivery, request_id, created_by)
         VALUES ($1, 'email', $2, $3, $4, $5, $6, 'sending', $7, $8) RETURNING id`,
        [ctx.tenantId, b.contact_id, b.gig_id ?? null, text, b.subject, ct.email, b.request_id, ctx.userId],
      );
      return {
        id: (ins.rows[0] as { id: string }).id,
        mail: { fromName: s.from_name, fromEmail: s.from_email, replyTo: s.reply_to, to: ct.email, subject: b.subject, text },
      };
    }).catch(async (err: unknown) => {
      // Two clicks at the same instant: the second loses the race on the unique request id.
      if ((err as { code?: string }).code === '23505') {
        const again = await withTenant(deps.pool, ctx, (c) => c.query(`${ACTIVITY_SELECT} WHERE a.request_id = $1`, [b.request_id]));
        if (again.rows[0]) return { existing: again.rows[0] } as Pre;
      }
      throw err;
    });

    if ('error' in pre) return reply.code(pre.status).send({ error: pre.error });
    if ('existing' in pre) return { ...(pre.existing as object), duplicate: true };

    // The provider is called outside any database transaction.
    let messageId: string | null = null;
    let failure: string | null = null;
    try {
      messageId = (await provider.send(pre.mail)).id;
    } catch (err) {
      if (!(err instanceof EmailError)) throw err;
      failure = err.message;
    }
    const out = await withTenant(deps.pool, ctx, async (c) => {
      await c.query(
        `UPDATE activity SET delivery = $2, provider_message_id = $3, delivery_error = $4, occurred_at = now() WHERE id = $1`,
        [pre.id, failure ? 'failed' : 'sent', messageId, failure],
      );
      return c.query(`${ACTIVITY_SELECT} WHERE a.id = $1`, [pre.id]);
    });
    if (failure) return reply.code(502).send({ error: 'send_failed', message: failure, activity: out.rows[0] });
    return reply.code(201).send(out.rows[0]);
  });
}
