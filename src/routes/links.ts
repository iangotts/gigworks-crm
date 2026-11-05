import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withTenant } from '../db.js';
import { slug, tagUrl } from '../links.js';
import { makeGuards } from './guard.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuidOrNull = z.preprocess(emptyToNull, z.string().uuid().nullable().optional());
const webUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => tagUrl(v, { source: 'x', medium: 'x' }) !== null, 'Use a web address that starts with http:// or https://');
const part = z.string().trim().max(200).transform(slug);
const optionalPart = z.preprocess(emptyToNull, part.nullable().optional());

const targetBody = z.object({
  name: z.string().trim().min(1).max(120),
  url: webUrl,
  sort_order: z.coerce.number().int().min(0).max(10000).default(0),
  active: z.boolean().default(true),
});
const targetUpdate = targetBody.partial().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

const linkBody = z.object({
  contact_id: uuidOrNull,
  gig_id: uuidOrNull,
  link_target_id: uuidOrNull,
  url: z.preprocess(emptyToNull, webUrl.nullable().optional()),
  utm_source: part.refine((v) => v.length > 0, 'Needs a source'),
  utm_medium: part.refine((v) => v.length > 0, 'Needs a medium'),
  utm_campaign: optionalPart,
  utm_content: optionalPart,
});
const listQuery = z.object({ contact_id: z.string().uuid().optional(), gig_id: z.string().uuid().optional() });
const idParam = z.object({ id: z.string().uuid() });
const clickBody = z.object({ clicked_at: z.string().datetime({ offset: true }).optional() });

const LINK_SQL = `
  SELECT l.id, l.contact_id, l.gig_id, l.link_target_id, l.destination_url,
         l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.created_at,
         t.name AS target_name, g.title AS gig_title, u.name AS by_name,
         (SELECT count(*)::int FROM link_click k WHERE k.tenant_id = l.tenant_id AND k.outbound_link_id = l.id) AS clicks,
         (SELECT max(k.clicked_at) FROM link_click k WHERE k.tenant_id = l.tenant_id AND k.outbound_link_id = l.id) AS last_click_at
    FROM outbound_link l
    LEFT JOIN link_target t ON t.tenant_id = l.tenant_id AND t.id = l.link_target_id
    LEFT JOIN gig g         ON g.tenant_id = l.tenant_id AND g.id = l.gig_id
    LEFT JOIN app_user u    ON u.id = l.created_by`;

export function registerLinkRoutes(app: FastifyInstance, deps: Deps): void {
  const { needTenant, needWrite } = makeGuards(deps);

  // The band's shareable links, with how often each was sent and clicked.
  app.get('/api/link-targets', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `SELECT t.id, t.name, t.url, t.sort_order, t.active,
                (SELECT count(*)::int FROM outbound_link l WHERE l.tenant_id = t.tenant_id AND l.link_target_id = t.id) AS sent,
                (SELECT count(*)::int FROM link_click k JOIN outbound_link l
                   ON l.tenant_id = k.tenant_id AND l.id = k.outbound_link_id
                  WHERE l.tenant_id = t.tenant_id AND l.link_target_id = t.id) AS clicks
           FROM link_target t ORDER BY t.active DESC, t.sort_order, lower(t.name)`,
      ),
    );
    return { targets: res.rows };
  });

  app.post('/api/link-targets', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = targetBody.parse(req.body);
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `INSERT INTO link_target (tenant_id, name, url, sort_order, active) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, url, sort_order, active, 0 AS sent, 0 AS clicks`,
        [ctx.tenantId, b.name, b.url, b.sort_order, b.active],
      ),
    );
    return reply.code(201).send(res.rows[0]);
  });

  app.patch('/api/link-targets/:id', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = targetUpdate.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${k} = $${values.length}`); // column names come only from the whitelist above
    }
    values.push(id);
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(`UPDATE link_target SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id, name, url, sort_order, active`, values),
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return res.rows[0];
  });

  // Links already built for a contact or a gig.
  app.get('/api/links', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const q = listQuery.parse(req.query);
    if (!q.contact_id && !q.gig_id) return reply.code(400).send({ error: 'needs_contact_or_gig' });
    const res = await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `${LINK_SQL} WHERE ($1::uuid IS NULL OR l.contact_id = $1) AND ($2::uuid IS NULL OR l.gig_id = $2)
          ORDER BY l.created_at DESC LIMIT 100`,
        [q.contact_id ?? null, q.gig_id ?? null],
      ),
    );
    return { links: res.rows };
  });

  // Build a tagged link, save it, and note it in the activity log. No contact identifier goes in the
  // address: it shows which link brought a visit, not who opened an email.
  app.post('/api/links', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const b = linkBody.parse(req.body);
    if (!b.contact_id && !b.gig_id) return reply.code(400).send({ error: 'needs_contact_or_gig' });
    if (!b.link_target_id && !b.url) return reply.code(400).send({ error: 'needs_link_or_url' });
    try {
      const out = await withTenant(deps.pool, ctx, async (c) => {
        let base = b.url ?? '';
        let label = b.url ?? '';
        if (b.link_target_id) {
          const t = await c.query<{ name: string; url: string }>('SELECT name, url FROM link_target WHERE id = $1', [b.link_target_id]);
          if (t.rowCount === 0) return { error: 'unknown_link_target' as const };
          base = (t.rows[0] as { url: string }).url;
          label = (t.rows[0] as { name: string }).name;
        }
        const tagged = tagUrl(base, { source: b.utm_source, medium: b.utm_medium, campaign: b.utm_campaign, content: b.utm_content });
        if (!tagged) return { error: 'invalid_request' as const };
        const ins = await c.query<{ id: string; contact_id: string | null }>(
          `INSERT INTO outbound_link
             (tenant_id, contact_id, link_target_id, gig_id, destination_url, utm_source, utm_medium, utm_campaign, utm_content, created_by)
           VALUES ($1, COALESCE($2::uuid, (SELECT contact_id FROM gig WHERE id = $3::uuid)), $4, $3::uuid, $5, $6, $7, $8, $9, $10)
           RETURNING id, contact_id`,
          [ctx.tenantId, b.contact_id ?? null, b.gig_id ?? null, b.link_target_id ?? null, tagged, b.utm_source, b.utm_medium, b.utm_campaign ?? null, b.utm_content ?? null, ctx.userId],
        );
        const row = ins.rows[0] as { id: string; contact_id: string | null };
        await c.query(
          `INSERT INTO activity (tenant_id, kind, contact_id, gig_id, body, created_by) VALUES ($1, 'note', $2, $3::uuid, $4, $5)`,
          [ctx.tenantId, row.contact_id, b.gig_id ?? null, `Link prepared: ${label}\n${tagged}`, ctx.userId],
        );
        return { link: (await c.query(`${LINK_SQL} WHERE l.id = $1`, [row.id])).rows[0] };
      });
      if ('error' in out) return reply.code(400).send({ error: out.error });
      return reply.code(201).send(out.link);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23503') return reply.code(400).send({ error: 'unknown_contact_or_gig' });
      if (code === '42501') return reply.code(403).send({ error: 'read_only' });
      throw err;
    }
  });

  // A click recorded by hand, until an analytics tool is chosen.
  app.post('/api/links/:id/clicks', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    const b = clickBody.parse(req.body ?? {});
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const link = await c.query('SELECT 1 FROM outbound_link WHERE id = $1', [id]);
      if (link.rowCount === 0) return null;
      await c.query(
        `INSERT INTO link_click (tenant_id, outbound_link_id, clicked_at, origin) VALUES ($1, $2, COALESCE($3::timestamptz, now()), 'manual')`,
        [ctx.tenantId, id, b.clicked_at ?? null],
      );
      return (await c.query(`${LINK_SQL} WHERE l.id = $1`, [id])).rows[0];
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return reply.code(201).send(out);
  });
}
