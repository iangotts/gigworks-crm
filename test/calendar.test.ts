// Google Calendar link: connecting, sharing, conflicts, and the event that follows a gig. Uses a fake Google. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, withSystem } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { decryptToken, encryptToken, makeState, readState } from '../src/calendar.js';
import { fakeGoogle } from '../src/google.js';

const PASSWORD = 'correct horse battery staple';
const tag = randomBytes(4).toString('hex');
const config: Config = { ...loadConfig({ ...process.env, SCRYPT_LOG_N: '10' }), allowedOrigins: ['http://app.test'] };
const pool = createPool(config.databaseUrl);

let app: FastifyInstance;
const ids: Record<string, string> = {};
const email = (n: string): string => `itest-${tag}-c${n}@example.test`;

async function makeUser(name: string, tenant: string, role: string): Promise<void> {
  const hash = await hashPassword(PASSWORD, 10);
  await withSystem(pool, async (c) => {
    const u = await c.query<{ id: string }>(
      'INSERT INTO app_user (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email(name), name, hash],
    );
    ids[name] = (u.rows[0] as { id: string }).id;
    await c.query('INSERT INTO membership (tenant_id, user_id, role) VALUES ($1, $2, $3)', [ids[tenant], ids[name], role]);
  });
}

async function login(name: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: email(name), password: PASSWORD } });
  const cookie = res.cookies.find((c) => c.name === 'gwcrm_session');
  return cookie ? { cookie: `gwcrm_session=${cookie.value}` } : {};
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

const google = fakeGoogle();
let a: Record<string, string>; // admin A (owner of the band calendar)
let m: Record<string, string>; // member A (shares a calendar)
let viewer: Record<string, string>; // read-only A
let b: Record<string, string>; // admin B
const gigOver = (o: object = {}) => ({ title: 'Smith wedding', stage: 'in_conversation', event_date: '2026-12-05', start_time: '19:00', end_time: '22:00', ...o });
const mkGig = async (o: object = {}): Promise<string> => (await call('POST', '/api/gigs', a, gigOver(o))).json().id;
const connect = async (h: Record<string, string>, who: string): Promise<number> => {
  const u = (await call('GET', '/api/calendar/connect', h)).json().url as string;
  const state = new URL(u).searchParams.get('state')!;
  const r = await app.inject({ method: 'GET', url: `/api/calendar/callback?code=good-${who}&state=${encodeURIComponent(state)}`, headers: h });
  return r.statusCode;
};
const events = () => [...google.events.values()];

beforeAll(async () => {
  app = await buildApp(config, pool, { loginLimit: 1000, google });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [`Cal Test ${k}`, `itest-c${k.toLowerCase()}-${tag}`]);
      ids[k] = (t.rows[0] as { id: string }).id;
    }
    await c.query("INSERT INTO venue (tenant_id, name, city) VALUES ($1, 'Rose Hall', 'Pasadena')", [ids.A]);
  });
  await makeUser('a', 'A', 'admin');
  await makeUser('m', 'A', 'member');
  await makeUser('viewer', 'A', 'read_only');
  await makeUser('b', 'B', 'admin');
  [a, m, viewer, b] = await Promise.all([login('a'), login('m'), login('viewer'), login('b')]);
});

afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-c%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-c%-${tag}`]);
  });
  await app.close();
  await pool.end();
});

describe('token protection', () => {
  it('encrypts a refresh token so the database never holds it in the clear', () => {
    const enc = encryptToken('1//refresh-secret', 'k1');
    expect(enc).not.toContain('refresh-secret');
    expect(decryptToken(enc, 'k1')).toBe('1//refresh-secret');
    expect(() => decryptToken(enc, 'other-key')).toThrow();
    expect(() => decryptToken(enc.slice(0, -3) + 'AAA', 'k1')).toThrow();
  });
  it('the sign-in state only works for its own person and only for 15 minutes', () => {
    const s = makeState('user-1', 'secret', 1000);
    expect(readState(s, 'secret', 1000 + 60_000)).toBe('user-1');
    expect(readState(s, 'secret', 1000 + 16 * 60_000)).toBeNull();
    expect(readState(s, 'different', 2000)).toBeNull();
    expect(readState(s.replace('user-1', 'user-2'), 'secret', 2000)).toBeNull();
    expect(readState('junk', 'secret')).toBeNull();
  });
});

describe('connecting Google', () => {
  it('is refused with a plain message while Google is not set up', async () => {
    const off = await buildApp(config, pool, { loginLimit: 1000 });
    const r = await off.inject({ method: 'GET', url: '/api/calendar/connect', headers: a });
    expect(r.statusCode).toBe(503);
    expect((await off.inject({ method: 'GET', url: '/api/calendar/status', headers: a })).json().configured).toBe(false);
    await off.close();
  });
  it('needs a login, and a stolen or wrong state cannot connect someone else', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/calendar/connect' })).statusCode).toBe(401);
    const u = (await call('GET', '/api/calendar/connect', a)).json().url as string;
    const state = new URL(u).searchParams.get('state')!;
    // Another person finishing a sign-in that A started
    const r = await app.inject({ method: 'GET', url: `/api/calendar/callback?code=good-evil&state=${encodeURIComponent(state)}`, headers: m });
    expect(r.headers.location).toContain('calendar=failed');
    const none = await withSystem(pool, (c) => c.query("SELECT 1 FROM calendar_connection WHERE google_email = 'evil'"));
    expect(none.rows).toHaveLength(0);
  });
  it('connects each person, stores only an encrypted token, and reports status', async () => {
    expect(await connect(a, 'a@gmail.test')).toBe(302);
    expect(await connect(m, 'm@gmail.test')).toBe(302);
    const row = await withSystem(pool, (c) => c.query("SELECT refresh_token_enc FROM calendar_connection WHERE google_email = 'a@gmail.test'"));
    expect(row.rows[0].refresh_token_enc).not.toContain('refresh-a@gmail.test');
    const st = (await call('GET', '/api/calendar/status', a)).json();
    expect(st.connection).toMatchObject({ google_email: 'a@gmail.test', status: 'ok' });
    expect(st.redirect_uri).toContain('/api/calendar/callback');
    expect((await call('GET', '/api/calendar/status', m)).json().redirect_uri).toBeUndefined();
  });
  it('a declined or failed Google step leaves nothing behind', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/calendar/callback?error=access_denied', headers: viewer });
    expect(r.headers.location).toContain('calendar=declined');
  });
});

describe('sharing and settings', () => {
  it('a member chooses which calendar the band may check, and only a real one', async () => {
    expect((await call('PUT', '/api/calendar/share', m, { calendar_id: 'not-mine@group.calendar.example' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/calendar/share', m, { calendar_id: 'primary' })).statusCode).toBe(200);
    const st = (await call('GET', '/api/calendar/status', a)).json();
    expect(st.sharing).toContain('m');
    expect(JSON.stringify(st)).not.toContain('primary"'); // others see names, not which calendar
  });
  it('someone who has not connected cannot share', async () => {
    const r = await call('PUT', '/api/calendar/share', viewer, { calendar_id: 'primary' });
    expect(r.statusCode).toBe(409);
  });
  it('only an admin sets where confirmed gigs go', async () => {
    expect((await call('PUT', '/api/calendar/settings', m, { calendar_id: 'primary', timezone: 'America/Los_Angeles' })).statusCode).toBe(403);
    expect((await call('PUT', '/api/calendar/settings', a, { calendar_id: 'primary', timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/calendar/settings', a, { calendar_id: 'nope', timezone: 'America/Los_Angeles' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/calendar/settings', b, { calendar_id: 'primary', timezone: 'America/Los_Angeles' })).statusCode).toBe(409); // b never connected
    expect((await call('PUT', '/api/calendar/settings', a, { calendar_id: 'primary', timezone: 'America/Los_Angeles' })).statusCode).toBe(200);
  });
});

describe('events follow the gig', () => {
  it('adds an event when a gig becomes Confirmed, with place, times and no money', async () => {
    google.events.clear();
    const venue = (await withSystem(pool, (c) => c.query("SELECT id FROM venue WHERE tenant_id = $1", [ids.A]))).rows[0].id;
    const id = await mkGig({ venue_id: venue, fee_quoted: 4200, notes: 'private note about the client' });
    expect(events()).toHaveLength(0); // not confirmed yet
    const r = await call('PATCH', `/api/gigs/${id}`, a, { stage: 'confirmed' });
    expect(r.statusCode).toBe(200);
    expect(events()).toHaveLength(1);
    const ev = events()[0]!.input;
    expect(ev).toMatchObject({ summary: 'Cal Test A: Smith wedding', location: 'Rose Hall, Pasadena', allDay: false, start: '2026-12-05T19:00:00', end: '2026-12-05T22:00:00', timeZone: 'America/Los_Angeles', gigId: id });
    expect(JSON.stringify(ev)).not.toContain('4200');
    expect(JSON.stringify(ev)).not.toContain('private note');
    const st = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(st.event.link).toContain('calendar.example.test');
    expect(st.problem).toBeNull();
  });
  it('a second edit that changes nothing in the event does not call Google again', async () => {
    const id = await mkGig({ stage: 'confirmed' });
    google.calls.length = 0;
    await call('PATCH', `/api/gigs/${id}`, a, { notes: 'just a note' });
    expect(google.calls.filter((x) => x === 'insert' || x === 'patch')).toHaveLength(0);
  });
  it('moves the event when the date or time changes, and never duplicates it', async () => {
    google.events.clear();
    const id = await mkGig({ stage: 'confirmed' });
    expect(events()).toHaveLength(1);
    await call('PATCH', `/api/gigs/${id}`, a, { event_date: '2026-12-12', start_time: '20:00', end_time: '23:30' });
    expect(events()).toHaveLength(1);
    expect(events()[0]!.input).toMatchObject({ start: '2026-12-12T20:00:00', end: '2026-12-12T23:30:00' });
  });
  it('two quick edits make one event, not two', async () => {
    google.events.clear();
    const id = await mkGig({ stage: 'in_conversation' });
    await Promise.all([call('PATCH', `/api/gigs/${id}`, a, { stage: 'confirmed' }), call('PATCH', `/api/gigs/${id}`, a, { title: 'Smith wedding party' })]);
    expect(events()).toHaveLength(1);
  });
  it('an all-day event when there is no start time, and past midnight when a set runs late', async () => {
    google.events.clear();
    await mkGig({ stage: 'confirmed', start_time: null, end_time: null });
    expect(events()[0]!.input).toMatchObject({ allDay: true, start: '2026-12-05', end: '2026-12-06' });
    google.events.clear();
    await mkGig({ stage: 'confirmed', start_time: '21:00', end_time: '01:00' });
    expect(events()[0]!.input).toMatchObject({ start: '2026-12-05T21:00:00', end: '2026-12-06T01:00:00' });
    google.events.clear();
    await mkGig({ stage: 'confirmed', start_time: '19:00', end_time: null });
    expect(events()[0]!.input.end).toBe('2026-12-05T22:00:00'); // three hours by default
  });
  it('removes the event when the gig is lost, postponed, archived, or loses its date', async () => {
    for (const change of [{ stage: 'lost' }, { postponed: true }, { archived: true }, { event_date: null }]) {
      google.events.clear();
      const id = await mkGig({ stage: 'confirmed' });
      expect(events()).toHaveLength(1);
      await call('PATCH', `/api/gigs/${id}`, a, change);
      expect(events(), JSON.stringify(change)).toHaveLength(0);
      expect((await call('GET', `/api/gigs/${id}/calendar`, a)).json().event).toBeNull();
    }
  });
  it('can also put the event on sharing members\' calendars with no invitation email, and it is not their conflict', async () => {
    await call('PUT', '/api/calendar/settings', a, { calendar_id: 'primary', timezone: 'America/Los_Angeles', add_members: true });
    google.events.clear();
    google.busyByCalendar.clear();
    const id = await mkGig({ stage: 'confirmed' });
    expect(events()[0]!.input.attendees).toEqual(['m@gmail.test']);
    const st = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(st.members.every((x: { busy: unknown[] }) => x.busy.length === 0)).toBe(true);
    await call('PUT', '/api/calendar/settings', a, { calendar_id: 'primary', timezone: 'America/Los_Angeles', add_members: false });
  });
  it('makes a fresh event if someone deleted it in Google', async () => {
    google.events.clear();
    const id = await mkGig({ stage: 'confirmed' });
    google.events.clear(); // deleted by hand in Google
    await call('PATCH', `/api/gigs/${id}`, a, { title: 'Renamed', stage: 'confirmed' });
    expect(events()).toHaveLength(1);
    expect(events()[0]!.input.summary).toContain('Renamed');
  });
  it('a Google failure never blocks the gig, shows a problem, and Try again fixes it', async () => {
    google.events.clear();
    google.failNext = 'Adding the event failed (500).';
    const id = await mkGig({ stage: 'confirmed' });
    expect(id).toBeTruthy(); // the gig saved
    const st = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(st.problem).toContain('failed');
    expect(events()).toHaveLength(0);
    const retry = await call('POST', `/api/gigs/${id}/calendar/sync`, m, {});
    expect(retry.json().result).toBe('created');
    expect(retry.json().problem).toBeNull();
    expect(events()).toHaveLength(1);
  });
  it('does nothing for a band that has not chosen a calendar', async () => {
    const before = events().length;
    const r = await call('POST', '/api/gigs', b, gigOver({ stage: 'confirmed' }));
    expect(r.statusCode).toBe(201);
    expect(events()).toHaveLength(before);
    expect((await call('GET', `/api/gigs/${r.json().id}/calendar`, b)).json().enabled).toBe(false);
  });
  it('read-only members can look but not sync', async () => {
    const id = await mkGig({ stage: 'confirmed' });
    expect((await call('GET', `/api/gigs/${id}/calendar`, viewer)).statusCode).toBe(200);
    expect((await call('POST', `/api/gigs/${id}/calendar/sync`, viewer, {})).statusCode).toBe(403);
  });
  it('another band cannot see this gig calendar state', async () => {
    const id = await mkGig({ stage: 'confirmed' });
    expect((await call('GET', `/api/gigs/${id}/calendar`, b)).statusCode).toBe(404);
  });
});

describe('conflicts', () => {
  it('shows who is busy at the gig time, without event titles, and ignores the gig itself and free time', async () => {
    google.events.clear();
    google.busyByCalendar.clear();
    google.busyByCalendar.set('access-m@gmail.test:primary', [
      { id: 'x1', start: '2026-12-06T04:00:00.000Z', end: '2026-12-06T05:00:00.000Z', allDay: false, gigId: null },
      { id: 'x2', start: '2026-12-05T01:00:00.000Z', end: '2026-12-05T02:00:00.000Z', allDay: false, gigId: null }, // earlier, no overlap
    ]);
    const id = await mkGig({ stage: 'in_conversation' });
    const st = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(st.window.from).toBe('2026-12-06T03:00:00.000Z');
    const mine = st.members.find((x: { status: string }) => x.status === 'ok');
    expect(mine.busy).toHaveLength(1);
    expect(JSON.stringify(st)).not.toContain('summary');
    // After the gig is confirmed and its own event is on that calendar, it is not a conflict with itself
    google.busyByCalendar.clear();
    await call('PATCH', `/api/gigs/${id}`, a, { stage: 'confirmed' });
    const again = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(again.members.every((x: { busy: unknown[] }) => x.busy.length === 0)).toBe(true);
  });
  it('asks for a date when the gig has none', async () => {
    const id = await mkGig({ event_date: null, start_time: null, end_time: null });
    const st = (await call('GET', `/api/gigs/${id}/calendar`, a)).json();
    expect(st.needs_date).toBe(true);
    expect(st.members).toEqual([]);
  });
  it('one member whose Google sign-in expired is flagged and does not break the page', async () => {
    const id = await mkGig({ stage: 'in_conversation' });
    google.revokedEmails.add('m@gmail.test');
    const fresh = await buildApp(config, pool, { loginLimit: 1000, google }); // a server with no cached tokens
    const r = await fresh.inject({ method: 'GET', url: `/api/gigs/${id}/calendar`, headers: a });
    expect(r.statusCode).toBe(200);
    expect(r.json().members[0]).toMatchObject({ name: 'm', status: 'needs_reconnect', busy: [] });
    const row = await withSystem(pool, (c) => c.query("SELECT status FROM calendar_connection WHERE google_email = 'm@gmail.test'"));
    expect(row.rows[0].status).toBe('needs_reconnect');
    await fresh.close();
    google.revokedEmails.delete('m@gmail.test');
    expect(await connect(m, 'm@gmail.test')).toBe(302); // connecting again repairs it
    expect((await call('GET', '/api/calendar/status', m)).json().connection.status).toBe('ok');
  });
  it('a band only reads calendars shared with that band', async () => {
    expect(await connect(b, 'b@gmail.test')).toBe(302);
    await call('PUT', '/api/calendar/share', b, { calendar_id: 'primary' });
    google.calls.length = 0;
    const id = await mkGig();
    await call('GET', `/api/gigs/${id}/calendar`, a);
    const read = google.calls.filter((x) => x.startsWith('busy:'));
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((x) => x.includes('m@gmail.test'))).toBe(true);
    expect(read.some((x) => x.includes('b@gmail.test'))).toBe(false);
  });
});

describe('disconnecting', () => {
  it('revokes at Google, deletes the stored token, and turns off what depended on it', async () => {
    expect((await call('DELETE', '/api/calendar/connection', a)).statusCode).toBe(204);
    expect(google.revoked.some((t) => t === 'refresh-a@gmail.test')).toBe(true);
    const left = await withSystem(pool, (c) => c.query("SELECT 1 FROM calendar_connection WHERE google_email = 'a@gmail.test'"));
    expect(left.rows).toHaveLength(0);
    const st = (await call('GET', '/api/calendar/status', a)).json();
    expect(st.connection).toBeNull();
    expect(st.settings).toBeNull(); // the band calendar was the admin's, so it goes too
    google.events.clear();
    await mkGig({ stage: 'confirmed' });
    expect(events()).toHaveLength(0);
  });
});
