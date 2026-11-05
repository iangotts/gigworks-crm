import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { toCsv } from '../csv.js';
import { withTenant } from '../db.js';
import { unsubToken } from '../tokens.js';
import { makeGuards } from './guard.js';

export const STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'suppressed'] as const;
export const ROLE_KINDS = ['booking_manager', 'organizer', 'client', 'sound', 'musician', 'band_member', 'venue_staff', 'other'] as const;

const emptyToUndef = (v: unknown): unknown => (v === '' ? undefined : v);
const filters = z.object({
  status: z.preprocess(emptyToUndef, z.enum(STATUSES).default('subscribed')),
  role: z.preprocess(emptyToUndef, z.enum(ROLE_KINDS).optional()),
  local: z.preprocess(emptyToUndef, z.enum(['yes', 'no']).optional()),
  tag: z.preprocess(emptyToUndef, z.string().trim().max(60).optional()),
  format: z.enum(['csv', 'json']).default('json'),
});

const setBody = z.object({
  status: z.enum(STATUSES),
  consent_source: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(300).optional()),
});
const idParam = z.object({ id: z.string().uuid() });

// The person must have said yes. Contacts with no subscription row, an unsubscribed row, a bounce or a
// suppression are never exported as subscribers.
const EXPORT_SQL = `
  SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.city, c.is_local, c.tags,
         s.status,
         coalesce((SELECT string_agg(DISTINCT r.kind, ';' ORDER BY r.kind) FROM contact_role r
                    WHERE r.tenant_id = c.tenant_id AND r.contact_id = c.id), '') AS roles
    FROM contact c
    JOIN subscription s ON s.tenant_id = c.tenant_id AND s.contact_id = c.id
   WHERE c.archived_at IS NULL AND c.email IS NOT NULL
     AND s.status = $1
     AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM contact_role r WHERE r.tenant_id = c.tenant_id AND r.contact_id = c.id AND r.kind = $2))
     AND ($3::boolean IS NULL OR c.is_local IS NOT DISTINCT FROM $3)
     AND ($4::text IS NULL OR $4 = ANY (c.tags))
   ORDER BY lower(c.email)`;

interface ExportRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  city: string | null;
  is_local: boolean | null;
  tags: string[];
  status: string;
  roles: string;
}

export function registerSubscriberRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);
  const { config } = deps;

  // How many people are in each state, for the Subscribers panel.
  app.get('/api/subscribers/summary', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const counts = await c.query<{ status: string; n: number }>(
        `SELECT s.status, count(*)::int AS n FROM subscription s JOIN contact c ON c.tenant_id = s.tenant_id AND c.id = s.contact_id
          WHERE c.archived_at IS NULL GROUP BY s.status`,
      );
      const none = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contact c
          WHERE c.archived_at IS NULL AND c.email IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.tenant_id = c.tenant_id AND s.contact_id = c.id)`,
      );
      const slug = await c.query<{ slug: string }>('SELECT slug FROM tenant WHERE id = $1', [ctx.tenantId]);
      return { counts: counts.rows, none: none.rows[0]?.n ?? 0, slug: slug.rows[0]?.slug ?? '' };
    });
    const by = Object.fromEntries(out.counts.map((r) => [r.status, r.n]));
    return {
      subscribed: by.subscribed ?? 0,
      unsubscribed: by.unsubscribed ?? 0,
      bounced: by.bounced ?? 0,
      suppressed: by.suppressed ?? 0,
      no_consent: out.none,
      subscribe_url: `${config.publicUrl}/subscribe/${out.slug}`,
    };
  });

  // The list for the bulk email tool. Read-only members cannot take the list away.
  app.get('/api/export/subscribers', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const f = filters.parse(req.query);
    const rows = await withTenant(deps.pool, ctx, async (c) => {
      const res = await c.query(EXPORT_SQL, [f.status, f.role ?? null, f.local === undefined ? null : f.local === 'yes', f.tag ?? null]);
      const slug = await c.query<{ slug: string }>('SELECT slug FROM tenant WHERE id = $1', [ctx.tenantId]);
      return { rows: res.rows as ExportRow[], slug: slug.rows[0]?.slug ?? 'band' };
    });
    const withLink = rows.rows.map((r) => ({ ...r, unsubscribe_url: `${config.publicUrl}/unsubscribe/${unsubToken(config.formSecret, r.id)}` }));
    if (f.format === 'json') {
      return { count: withLink.length, sample: withLink.slice(0, 10).map(({ id: _id, ...rest }) => rest) };
    }
    const header = ['email', 'first_name', 'last_name', 'company', 'city', 'local', 'tags', 'roles', 'status', 'unsubscribe_url'];
    const body = toCsv(
      header,
      withLink.map((r) => [r.email, r.first_name, r.last_name, r.company, r.city, r.is_local === null ? '' : r.is_local ? 'yes' : 'no', r.tags.join(';'), r.roles, r.status, r.unsubscribe_url]),
    );
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${rows.slug}-${f.status}-${day}.csv"`)
      .header('cache-control', 'no-store')
      .send(body);
  });

  // A person changes someone's consent. Saying yes needs a note of where it came from.
  app.put('/api/contacts/:id/subscription', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = setBody.parse(req.body);
    if (b.status === 'subscribed' && !b.consent_source) return reply.code(400).send({ error: 'needs_consent_source' });
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const contact = await c.query<{ email: string | null }>('SELECT email FROM contact WHERE id = $1 AND archived_at IS NULL', [id]);
      if (contact.rowCount === 0) return { error: 'not_found' as const };
      if (!(contact.rows[0] as { email: string | null }).email) return { error: 'needs_email' as const };
      const saved = await c.query(
        `INSERT INTO subscription (tenant_id, contact_id, status, consent_source, consented_at, unsubscribed_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'subscribed' THEN now() END, CASE WHEN $3 = 'unsubscribed' THEN now() END)
         ON CONFLICT (tenant_id, contact_id) DO UPDATE SET
           status = EXCLUDED.status,
           consent_source = CASE WHEN EXCLUDED.status = 'subscribed' THEN EXCLUDED.consent_source ELSE subscription.consent_source END,
           consented_at = CASE WHEN EXCLUDED.status = 'subscribed' THEN now() ELSE subscription.consented_at END,
           unsubscribed_at = CASE WHEN EXCLUDED.status = 'unsubscribed' THEN now()
                                  WHEN EXCLUDED.status = 'subscribed' THEN NULL ELSE subscription.unsubscribed_at END
         RETURNING status, consent_source, consented_at, unsubscribed_at`,
        [ctx.tenantId, id, b.status, b.consent_source ?? null],
      );
      const note =
        b.status === 'subscribed' ? `Marked as subscribed. Where they agreed: ${b.consent_source}`
        : b.status === 'unsubscribed' ? 'Marked as unsubscribed.'
        : b.status === 'bounced' ? 'Marked as bounced: emails to this address do not arrive.'
        : 'Marked as suppressed: never email this address.';
      await c.query(`INSERT INTO activity (tenant_id, kind, contact_id, body, created_by) VALUES ($1, 'note', $2, $3, $4)`, [ctx.tenantId, id, note, ctx.userId]);
      return { subscription: saved.rows[0] };
    });
    if ('error' in out) return reply.code(out.error === 'not_found' ? 404 : 400).send({ error: out.error });
    return out.subscription;
  });
}
