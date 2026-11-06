import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { withSystem, withTenant, withUser, type TenantContext } from './db.js';
import { addDays, addHoursLocal, hhmm, localToInstant, validTimeZone } from './caltime.js';
import { GoogleError, type BusyEvent, type EventInput, type GoogleClient } from './google.js';

// ---- encryption of stored refresh tokens
const keyOf = (secret: string): Buffer => createHash('sha256').update(`gwcrm-calendar-v1:${secret}`).digest();

export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptToken(enc: string, secret: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable calendar token');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---- the sign-in state: proves the Google redirect belongs to the person who started it
const STATE_MINUTES = 15;
const sign = (payload: string, secret: string): string => createHmac('sha256', `gwcrm-calendar-state:${secret}`).update(payload).digest('base64url');

export function makeState(userId: string, secret: string, now = Date.now()): string {
  const payload = `${userId}.${now}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readState(state: string, secret: string, now = Date.now()): string | null {
  const [userId, ts, mac] = state.split('.');
  if (!userId || !ts || !mac) return null;
  const want = sign(`${userId}.${ts}`, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const age = now - Number(ts);
  return age >= 0 && age <= STATE_MINUTES * 60_000 ? userId : null;
}

// ---- what the service returns
export interface MemberBusy {
  user_id: string;
  name: string;
  status: 'ok' | 'needs_reconnect' | 'error';
  message?: string;
  busy: { start: string; end: string; all_day: boolean }[];
}
export interface GigCalendarState {
  /** The band has chosen where confirmed gigs go. */
  enabled: boolean;
  timezone: string;
  event: { link: string | null; synced_at: string } | null;
  problem: string | null;
  needs_date: boolean;
  window: { from: string; to: string } | null;
  members: MemberBusy[];
}

interface GigRow {
  id: string;
  title: string;
  stage: string;
  postponed: boolean;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  archived_at: string | null;
  venue_name: string | null;
  venue_city: string | null;
  contact_name: string | null;
  band: string;
}
interface Settings {
  owner_user_id: string;
  calendar_id: string;
  timezone: string;
  add_members: boolean;
}

const GIG_SQL = `
  SELECT g.id, g.title, g.stage, g.postponed, g.event_date, g.start_time, g.end_time, g.archived_at,
         v.name AS venue_name, v.city AS venue_city,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
         t.name AS band
    FROM gig g
    JOIN tenant t ON t.id = g.tenant_id
    LEFT JOIN venue v   ON v.tenant_id = g.tenant_id AND v.id = g.venue_id
    LEFT JOIN contact c ON c.tenant_id = g.tenant_id AND c.id = g.contact_id
   WHERE g.id = $1`;

/** Gig to the event it should have, or null when it should have none. */
export function desiredEvent(g: GigRow, tz: string, attendees: string[]): EventInput | null {
  const live = (g.stage === 'confirmed' && !g.postponed) || g.stage === 'played';
  if (!live || g.archived_at || !g.event_date) return null;
  const place = [g.venue_name, g.venue_city].filter(Boolean).join(', ');
  const description = ['Booked in GW-CRM.', g.contact_name ? `Contact: ${g.contact_name}` : null].filter(Boolean).join('\n');
  const base = { summary: `${g.band}: ${g.title}`, ...(place ? { location: place } : {}), description, timeZone: tz, gigId: g.id, attendees };
  if (!g.start_time) return { ...base, allDay: true, start: g.event_date, end: addDays(g.event_date, 1) };
  const start = hhmm(g.start_time);
  let end = g.end_time ? { date: g.event_date, time: hhmm(g.end_time) } : addHoursLocal(g.event_date, start, 3);
  // A set that ends after midnight has an end time earlier on the clock than its start.
  if (g.end_time && end.time <= start) end = { date: addDays(g.event_date, 1), time: end.time };
  return { ...base, allDay: false, start: `${g.event_date}T${start}:00`, end: `${end.date}T${end.time}:00` };
}

export class CalendarService {
  private tokens = new Map<string, { token: string; exp: number }>();
  /** One sync at a time per gig, so two quick edits never create two events. This server runs as one process. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly pool: pg.Pool,
    private config: Config,
    readonly google: GoogleClient,
  ) {}

  connectUrl(userId: string): string {
    return this.google.authUrl(makeState(userId, this.config.formSecret));
  }

  async completeConnect(userId: string, code: string): Promise<{ email: string }> {
    const t = await this.google.exchangeCode(code);
    await withUser(this.pool, userId, (c) =>
      c.query(
        `INSERT INTO calendar_connection (user_id, google_email, refresh_token_enc, status)
         VALUES ($1, $2, $3, 'ok')
         ON CONFLICT (user_id) DO UPDATE SET google_email = EXCLUDED.google_email, refresh_token_enc = EXCLUDED.refresh_token_enc, status = 'ok'`,
        [userId, t.email, encryptToken(t.refreshToken, this.config.calendarKey)],
      ),
    );
    this.tokens.set(userId, { token: t.accessToken, exp: Date.now() + (t.expiresInSec - 60) * 1000 });
    return { email: t.email };
  }

  /** A working access token for a person, or a GoogleError that says they must connect again. */
  async accessTokenFor(userId: string): Promise<string> {
    const hit = this.tokens.get(userId);
    if (hit && hit.exp > Date.now()) return hit.token;
    // Read through the owner path: the caller has already shown this person belongs to the active band.
    const row = await withSystem(this.pool, async (c) => (await c.query<{ refresh_token_enc: string; status: string }>('SELECT refresh_token_enc, status FROM calendar_connection WHERE user_id = $1', [userId])).rows[0]);
    if (!row) throw new GoogleError('This person has not connected Google Calendar.', true);
    if (row.status !== 'ok') throw new GoogleError('Google no longer accepts this sign-in. Connect again.', true);
    try {
      const r = await this.google.accessToken(decryptToken(row.refresh_token_enc, this.config.calendarKey));
      this.tokens.set(userId, { token: r.accessToken, exp: Date.now() + (r.expiresInSec - 60) * 1000 });
      return r.accessToken;
    } catch (err) {
      if (err instanceof GoogleError && err.needsReconnect) {
        this.tokens.delete(userId);
        await withSystem(this.pool, (c) => c.query("UPDATE calendar_connection SET status = 'needs_reconnect' WHERE user_id = $1", [userId]));
      }
      throw err;
    }
  }

  async disconnect(userId: string): Promise<void> {
    const row = await withSystem(this.pool, async (c) => (await c.query<{ refresh_token_enc: string }>('SELECT refresh_token_enc FROM calendar_connection WHERE user_id = $1', [userId])).rows[0]);
    if (row) {
      try {
        await this.google.revoke(decryptToken(row.refresh_token_enc, this.config.calendarKey));
      } catch {
        /* the sign-in is removed here either way */
      }
    }
    this.tokens.delete(userId);
    // Shares and the band's calendar settings go with it through the foreign keys.
    await withUser(this.pool, userId, (c) => c.query('DELETE FROM calendar_connection WHERE user_id = $1', [userId]));
  }

  /** Who in this band shares a calendar, with their connection state. */
  private async sharingMembers(tenantId: string): Promise<{ user_id: string; name: string; email: string; google_email: string; calendar_id: string; status: string }[]> {
    return withSystem(this.pool, async (c) =>
      (
        await c.query(
          `SELECT s.user_id, coalesce(u.name, u.email) AS name, u.email, cc.google_email, s.calendar_id, cc.status
             FROM calendar_share s
             JOIN membership m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
             JOIN calendar_connection cc ON cc.user_id = s.user_id
             JOIN app_user u ON u.id = s.user_id
            WHERE s.tenant_id = $1 ORDER BY lower(coalesce(u.name, u.email))`,
          [tenantId],
        )
      ).rows,
    );
  }

  private async settingsOf(ctx: TenantContext): Promise<Settings | null> {
    return withTenant(this.pool, ctx, async (c) => (await c.query<Settings>('SELECT owner_user_id, calendar_id, timezone, add_members FROM calendar_settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0] ?? null);
  }

  /** Who is busy around a gig, and the state of its calendar event. Never throws for one member's trouble. */
  async gigState(ctx: TenantContext, gigId: string): Promise<GigCalendarState | null> {
    const loaded = await withTenant(this.pool, ctx, async (c) => {
      const g = (await c.query<GigRow>(GIG_SQL, [gigId])).rows[0];
      if (!g) return null;
      const ev = (await c.query<{ html_link: string | null; synced_at: string }>('SELECT html_link, synced_at FROM gig_calendar_event WHERE gig_id = $1', [gigId])).rows[0];
      const pr = (await c.query<{ message: string }>('SELECT message FROM gig_calendar_problem WHERE gig_id = $1', [gigId])).rows[0];
      return { g, ev, pr };
    });
    if (!loaded) return null;
    const settings = await this.settingsOf(ctx);
    const tz = settings?.timezone ?? 'America/Los_Angeles';
    const out: GigCalendarState = {
      enabled: settings !== null,
      timezone: tz,
      event: loaded.ev ? { link: loaded.ev.html_link, synced_at: loaded.ev.synced_at } : null,
      problem: loaded.pr?.message ?? null,
      needs_date: !loaded.g.event_date,
      window: null,
      members: [],
    };
    if (!loaded.g.event_date) return out;
    const d = loaded.g.event_date;
    const from = loaded.g.start_time ? localToInstant(d, hhmm(loaded.g.start_time), tz) : localToInstant(d, '00:00', tz);
    let to: string;
    if (loaded.g.start_time) {
      const e = desiredEventWindowEnd(loaded.g);
      to = localToInstant(e.date, e.time, tz);
    } else to = localToInstant(addDays(d, 1), '00:00', tz);
    out.window = { from, to };
    const members = await this.sharingMembers(ctx.tenantId);
    out.members = await Promise.all(
      members.map(async (m): Promise<MemberBusy> => {
        if (m.status !== 'ok') return { user_id: m.user_id, name: m.name, status: 'needs_reconnect', busy: [] };
        try {
          const token = await this.accessTokenFor(m.user_id);
          const events = await this.google.listBusy(token, m.calendar_id, from, to);
          const mine = events.filter((e: BusyEvent) => e.gigId !== gigId); // this gig's own event is not a conflict
          return { user_id: m.user_id, name: m.name, status: 'ok', busy: mine.map((e) => ({ start: e.start, end: e.end, all_day: e.allDay })) };
        } catch (err) {
          if (err instanceof GoogleError && err.needsReconnect) return { user_id: m.user_id, name: m.name, status: 'needs_reconnect', busy: [] };
          return { user_id: m.user_id, name: m.name, status: 'error', message: err instanceof GoogleError ? err.message : 'Could not read this calendar.', busy: [] };
        }
      }),
    );
    return out;
  }

  /** Make the gig's calendar event match the gig. Records a problem instead of throwing. */
  sync(ctx: TenantContext, gigId: string): Promise<'off' | 'created' | 'updated' | 'removed' | 'unchanged' | 'problem'> {
    const prev = this.chains.get(gigId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.syncNow(ctx, gigId))
      .catch((): 'problem' => 'problem'); // the gig was already saved, so a failure here must not undo that
    this.chains.set(gigId, run);
    void run.finally(() => {
      if (this.chains.get(gigId) === run) this.chains.delete(gigId);
    }).catch(() => undefined);
    return run;
  }

  private async syncNow(ctx: TenantContext, gigId: string) {
    const settings = await this.settingsOf(ctx);
    if (!settings) return 'off' as const;
    const state = await withTenant(this.pool, ctx, async (c) => ({
      g: (await c.query<GigRow>(GIG_SQL, [gigId])).rows[0],
      ev: (
        await c.query<{ google_event_id: string; owner_user_id: string; calendar_id: string; content_hash: string }>(
          'SELECT google_event_id, owner_user_id, calendar_id, content_hash FROM gig_calendar_event WHERE gig_id = $1',
          [gigId],
        )
      ).rows[0],
    }));
    if (!state.g) return 'off' as const;
    try {
      let attendees: string[] = [];
      if (settings.add_members) {
        const sharing = await this.sharingMembers(ctx.tenantId);
        const ownerEmail = sharing.find((m) => m.user_id === settings.owner_user_id)?.google_email;
        attendees = sharing.filter((m) => m.status === 'ok' && m.user_id !== settings.owner_user_id && m.google_email !== ownerEmail).map((m) => m.google_email);
      }
      const want = desiredEvent(state.g, settings.timezone, attendees);
      const record = (c: pg.PoolClient, id: string, link: string | null, hash: string, calendarId: string, ownerId: string) =>
        c.query(
          `INSERT INTO gig_calendar_event (tenant_id, gig_id, google_event_id, owner_user_id, calendar_id, html_link, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, gig_id) DO UPDATE SET google_event_id = EXCLUDED.google_event_id, owner_user_id = EXCLUDED.owner_user_id,
             calendar_id = EXCLUDED.calendar_id, html_link = EXCLUDED.html_link, content_hash = EXCLUDED.content_hash, synced_at = now()`,
          [ctx.tenantId, gigId, id, ownerId, calendarId, link, hash],
        );
      const clearProblem = (c: pg.PoolClient) => c.query('DELETE FROM gig_calendar_problem WHERE gig_id = $1', [gigId]);

      if (!want) {
        if (!state.ev) return 'unchanged' as const;
        const token = await this.accessTokenFor(state.ev.owner_user_id);
        await this.google.deleteEvent(token, state.ev.calendar_id, state.ev.google_event_id);
        await withTenant(this.pool, ctx, async (c) => {
          await c.query('DELETE FROM gig_calendar_event WHERE gig_id = $1', [gigId]);
          await clearProblem(c);
        });
        return 'removed' as const;
      }
      const hash = createHash('sha256').update(JSON.stringify([want, settings.calendar_id, settings.owner_user_id])).digest('hex');
      if (state.ev && state.ev.content_hash === hash) {
        await withTenant(this.pool, ctx, clearProblem);
        return 'unchanged' as const;
      }
      const ownerId = state.ev?.owner_user_id ?? settings.owner_user_id;
      const calendarId = state.ev?.calendar_id ?? settings.calendar_id;
      const token = await this.accessTokenFor(ownerId);
      if (state.ev) {
        try {
          const r = await this.google.patchEvent(token, calendarId, state.ev.google_event_id, want);
          await withTenant(this.pool, ctx, async (c) => {
            await record(c, r.id, r.htmlLink, hash, calendarId, ownerId);
            await clearProblem(c);
          });
          return 'updated' as const;
        } catch (err) {
          // Someone deleted the event in Google. Make a fresh one rather than failing forever.
          if (!(err instanceof GoogleError) || !/deleted in Google/.test(err.message)) throw err;
        }
      }
      const t2 = await this.accessTokenFor(settings.owner_user_id);
      const r = await this.google.insertEvent(t2, settings.calendar_id, want);
      await withTenant(this.pool, ctx, async (c) => {
        await record(c, r.id, r.htmlLink, hash, settings.calendar_id, settings.owner_user_id);
        await clearProblem(c);
      });
      return 'created' as const;
    } catch (err) {
      const message = err instanceof GoogleError ? err.message : 'The calendar could not be updated.';
      await withTenant(this.pool, ctx, (c) =>
        c.query(
          `INSERT INTO gig_calendar_problem (tenant_id, gig_id, message) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, gig_id) DO UPDATE SET message = EXCLUDED.message, noted_at = now()`,
          [ctx.tenantId, gigId, message],
        ),
      ).catch(() => undefined);
      return 'problem' as const;
    }
  }

  validTimeZone = validTimeZone;
}

function desiredEventWindowEnd(g: GigRow): { date: string; time: string } {
  const d = g.event_date as string;
  const start = hhmm(g.start_time as string);
  if (g.end_time) {
    const e = hhmm(g.end_time);
    return e <= start ? { date: addDays(d, 1), time: e } : { date: d, time: e };
  }
  return addHoursLocal(d, start, 3);
}
