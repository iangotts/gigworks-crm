import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, type Deps } from '../auth.js';
import { readState, type CalendarService } from '../calendar.js';
import { validTimeZone } from '../caltime.js';
import { withTenant, withUser } from '../db.js';
import { GoogleError } from '../google.js';
import { makeGuards } from './guard.js';

const settingsBody = z.object({
  calendar_id: z.string().trim().min(1).max(300).default('primary'),
  timezone: z.string().trim().min(1).max(60).refine(validTimeZone, 'Not a time zone'),
  add_members: z.boolean().default(false),
});
const shareBody = z.object({ calendar_id: z.string().trim().min(1).max(300).nullable() });
const idParam = z.object({ id: z.string().uuid() });

export function registerCalendarRoutes(app: FastifyInstance, deps: Deps, cal: CalendarService | null): void {
  const { needTenant, needWrite } = makeGuards(deps);
  const configured = deps.config.googleClientId !== '';
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const off = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(503).send({ error: 'calendar_not_configured' });

  app.get('/api/calendar/status', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const out = await withTenant(deps.pool, ctx, async (c) => {
      const conn = (await c.query<{ google_email: string; status: string }>('SELECT google_email, status FROM calendar_connection WHERE user_id = $1', [ctx.userId])).rows[0] ?? null;
      const share = (await c.query<{ calendar_id: string }>('SELECT calendar_id FROM calendar_share WHERE user_id = $1 AND tenant_id = $2', [ctx.userId, ctx.tenantId])).rows[0] ?? null;
      const settings = (await c.query<{ owner_user_id: string; calendar_id: string; timezone: string; add_members: boolean }>('SELECT owner_user_id, calendar_id, timezone, add_members FROM calendar_settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0] ?? null;
      // Names only. Which calendar each person shares stays private to them.
      const sharing = (
        await c.query<{ name: string }>(
          `SELECT coalesce(u.name, u.email) AS name FROM calendar_share s JOIN app_user u ON u.id = s.user_id
            WHERE s.tenant_id = $1 ORDER BY lower(coalesce(u.name, u.email))`,
          [ctx.tenantId],
        )
      ).rows.map((r) => r.name);
      return { conn, share, settings, sharing };
    });
    return {
      configured,
      connection: out.conn,
      share: out.share,
      settings: out.settings ? { ...out.settings, mine: out.settings.owner_user_id === ctx.userId, owner_user_id: undefined } : null,
      sharing: out.sharing,
      redirect_uri: ctx.role === 'admin' ? `${deps.config.publicUrl}/api/calendar/callback` : undefined,
    };
  });

  // Starts the Google sign-in. The browser is sent to the address returned.
  app.get('/api/calendar/connect', limit(10), async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    if (!cal) return off(reply);
    return { url: cal.connectUrl(auth.userId) };
  });

  // Google sends the browser back here. The state proves it is the same person who started it.
  app.get('/api/calendar/callback', limit(20), async (req, reply) => {
    const back = (flag: string): unknown => reply.redirect(`${deps.config.publicUrl}/?calendar=${flag}#/pipeline`);
    const auth = await authenticate(deps, req);
    if (!auth || !cal) return back('failed');
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(500).optional(), error: z.string().max(200).optional() }).safeParse(req.query);
    if (!q.success || q.data.error || !q.data.code || !q.data.state) return back(q.success && q.data.error === 'access_denied' ? 'declined' : 'failed');
    if (readState(q.data.state, deps.config.formSecret) !== auth.userId) return back('failed');
    try {
      await cal.completeConnect(auth.userId, q.data.code);
    } catch {
      return back('failed');
    }
    return back('connected');
  });

  app.get('/api/calendar/calendars', limit(30), async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    if (!cal) return off(reply);
    try {
      return { calendars: await cal.google.listCalendars(await cal.accessTokenFor(auth.userId)) };
    } catch (err) {
      if (err instanceof GoogleError) return reply.code(err.needsReconnect ? 409 : 502).send({ error: err.needsReconnect ? 'needs_reconnect' : 'google_failed', message: err.message });
      throw err;
    }
  });

  app.delete('/api/calendar/connection', async (req, reply) => {
    const auth = await authenticate(deps, req);
    if (!auth) return reply.code(401).send({ error: 'not_logged_in' });
    if (!cal) return off(reply);
    await cal.disconnect(auth.userId);
    return reply.code(204).send();
  });

  // Whether this band may look at one of my calendars for conflicts.
  app.put('/api/calendar/share', async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    if (!cal) return off(reply);
    const b = shareBody.parse(req.body);
    if (b.calendar_id === null) {
      await withTenant(deps.pool, ctx, (c) => c.query('DELETE FROM calendar_share WHERE user_id = $1 AND tenant_id = $2', [ctx.userId, ctx.tenantId]));
      return { share: null };
    }
    let list;
    try {
      list = await cal.google.listCalendars(await cal.accessTokenFor(ctx.userId));
    } catch (err) {
      if (err instanceof GoogleError) return reply.code(err.needsReconnect ? 409 : 502).send({ error: err.needsReconnect ? 'needs_reconnect' : 'google_failed', message: err.message });
      throw err;
    }
    if (!list.some((x) => x.id === b.calendar_id)) return reply.code(400).send({ error: 'unknown_calendar' });
    await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `INSERT INTO calendar_share (user_id, tenant_id, calendar_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id`,
        [ctx.userId, ctx.tenantId, b.calendar_id],
      ),
    );
    return { share: { calendar_id: b.calendar_id } };
  });

  // Admin: which connected calendar receives this band's confirmed gigs.
  app.put('/api/calendar/settings', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    if (!cal) return off(reply);
    if (ctx.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });
    const b = settingsBody.parse(req.body);
    const has = await withUser(deps.pool, ctx.userId, async (c) => (await c.query("SELECT 1 FROM calendar_connection WHERE user_id = $1 AND status = 'ok'", [ctx.userId])).rows[0]);
    if (!has) return reply.code(409).send({ error: 'connect_first' });
    let list;
    try {
      list = await cal.google.listCalendars(await cal.accessTokenFor(ctx.userId));
    } catch (err) {
      if (err instanceof GoogleError) return reply.code(err.needsReconnect ? 409 : 502).send({ error: err.needsReconnect ? 'needs_reconnect' : 'google_failed', message: err.message });
      throw err;
    }
    if (!list.some((x) => x.id === b.calendar_id)) return reply.code(400).send({ error: 'unknown_calendar' });
    await withTenant(deps.pool, ctx, (c) =>
      c.query(
        `INSERT INTO calendar_settings (tenant_id, owner_user_id, calendar_id, timezone, add_members)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, calendar_id = EXCLUDED.calendar_id,
           timezone = EXCLUDED.timezone, add_members = EXCLUDED.add_members`,
        [ctx.tenantId, ctx.userId, b.calendar_id, b.timezone, b.add_members],
      ),
    );
    return { ok: true };
  });

  app.delete('/api/calendar/settings', async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });
    await withTenant(deps.pool, ctx, (c) => c.query('DELETE FROM calendar_settings WHERE tenant_id = $1', [ctx.tenantId]));
    return reply.code(204).send();
  });

  // Conflicts around a gig and the state of its event.
  app.get('/api/gigs/:id/calendar', limit(60), async (req, reply) => {
    const ctx = await needTenant(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    if (!cal) return { configured: false };
    const s = await cal.gigState(ctx, id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    return { configured: true, ...s };
  });

  // Try again after a problem, or add the event now.
  app.post('/api/gigs/:id/calendar/sync', limit(20), async (req, reply) => {
    const ctx = await needWrite(req, reply);
    if (!ctx) return reply;
    const { id } = idParam.parse(req.params);
    if (!cal) return off(reply);
    const result = await cal.sync(ctx, id);
    const s = await cal.gigState(ctx, id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    return { configured: true, result, ...s };
  });
}
