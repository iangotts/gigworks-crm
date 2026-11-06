// Contacts, activity, follow-ups and templates API tests. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, withSystem } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';

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

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

let a: Record<string, string>; // member in tenant A
let b: Record<string, string>; // member in tenant B
let viewer: Record<string, string>;

beforeAll(async () => {
  app = await buildApp(config, pool, { loginLimit: 1000 });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [
        `Contact Test ${k}`, `itest-c${k.toLowerCase()}-${tag}`,
      ]);
      ids[k] = (t.rows[0] as { id: string }).id;
    }
    const cb = await c.query<{ id: string }>(
      "INSERT INTO contact (tenant_id, first_name, last_name) VALUES ($1, 'Bee', 'Contact') RETURNING id", [ids.B],
    );
    ids.contactB = (cb.rows[0] as { id: string }).id;
    const vb = await c.query<{ id: string }>("INSERT INTO venue (tenant_id, name) VALUES ($1, 'Bee Hall') RETURNING id", [ids.B]);
    ids.venueB = (vb.rows[0] as { id: string }).id;
  });
  await makeUser('a', 'A', 'member');
  await makeUser('b', 'B', 'member');
  await makeUser('viewer', 'A', 'read_only');
  [a, b, viewer] = await Promise.all([login('a'), login('b'), login('viewer')]);
});

afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-c%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-c%-${tag}`]);
  });
  await app.close();
  await pool.end();
});


const mk = async (who: Record<string, string>, body: object) => (await call('POST', '/api/contacts', who, body)).json();

describe('contacts', () => {
  it('lists, searches, filters by tag and sorts', async () => {
    const x = await mk(a, { first_name: 'Priya', last_name: 'Shah', email: 'Priya@Example.test', company: 'Shah Events', tags: ['wedding'] });
    await mk(a, { first_name: 'Al', last_name: 'Zed', tags: ['venue-organizer'] });
    expect(x.email).toBe('priya@example.test');
    const all = (await call('GET', '/api/contacts', a)).json().contacts;
    expect(all.map((c: { last_name: string }) => c.last_name)).toEqual(['Shah', 'Zed']);
    expect((await call('GET', '/api/contacts?q=shah%20events', a)).json().contacts).toHaveLength(1);
    expect((await call('GET', '/api/contacts?tag=wedding', a)).json().contacts).toHaveLength(1);
    const tags = (await call('GET', '/api/contacts/tags', a)).json().tags.map((t: { tag: string }) => t.tag).sort();
    expect(tags).toEqual(['venue-organizer', 'wedding']);
    ids.priya = x.id;
  });

  it('keeps bands apart', async () => {
    const theirs = (await call('GET', '/api/contacts', b)).json().contacts;
    expect(theirs.map((c: { last_name: string }) => c.last_name)).toEqual(['Contact']); // only B's own seeded contact
    expect((await call('GET', `/api/contacts/${ids.priya}`, b)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/contacts/${ids.priya}`, b, { city: 'x' })).statusCode).toBe(404);
  });

  it('refuses a duplicate email in the same band but allows it in another', async () => {
    expect((await call('POST', '/api/contacts', a, { email: 'priya@example.test' })).statusCode).toBe(409);
    expect((await call('POST', '/api/contacts', b, { email: 'priya@example.test' })).statusCode).toBe(201);
  });

  it('shows detail with gigs, edits only the fields sent, and archives', async () => {
    const g = (await call('POST', '/api/gigs', a, { title: 'Shah wedding', contact_id: ids.priya, stage: 'evaluating' })).json();
    ids.gig = g.id;
    const d = (await call('GET', `/api/contacts/${ids.priya}`, a)).json();
    expect(d.contact.open_gigs).toBe(1);
    expect(d.gigs[0].title).toBe('Shah wedding');
    const p = await call('PATCH', `/api/contacts/${ids.priya}`, a, { city: 'Oakland', tags: ['wedding', 'repeat'], tenant_id: ids.B });
    expect(p.statusCode).toBe(200);
    const after = (await call('GET', `/api/contacts/${ids.priya}`, a)).json().contact;
    expect(after.city).toBe('Oakland');
    expect(after.company).toBe('Shah Events');
    expect((await call('PATCH', `/api/contacts/${ids.priya}`, a, {})).statusCode).toBe(400);
    const zed = (await call('GET', '/api/contacts?q=zed', a)).json().contacts[0];
    expect((await call('PATCH', `/api/contacts/${zed.id}`, a, { archived: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/contacts?q=zed', a)).json().contacts).toHaveLength(0);
  });

  it('is closed to read-only members for writes but they can read', async () => {
    expect((await call('GET', '/api/contacts', viewer)).statusCode).toBe(200);
    const r = await call('PATCH', `/api/contacts/${ids.priya}`, viewer, { city: 'Nope' });
    expect(r.statusCode).toBe(403);
    expect((await call('POST', '/api/contacts', viewer, { first_name: 'No' })).statusCode).toBe(403);
  });
});

describe('activity', () => {
  it('logs a call and lists it newest first, with the author', async () => {
    const r = await call('POST', '/api/activity', a, { kind: 'call', contact_id: ids.priya, body: 'Left details for a June date' });
    expect(r.statusCode).toBe(201);
    expect(r.json().by_name).toBe('a');
    await call('POST', '/api/activity', a, { kind: 'note', contact_id: ids.priya, body: 'Prefers text', occurred_at: '2020-01-01T10:00:00Z' });
    const list = (await call('GET', `/api/activity?contact_id=${ids.priya}`, a)).json().activity;
    expect(list.map((x: { kind: string }) => x.kind)).toEqual(['call', 'note']);
  });

  it('puts a gig note on the gig contact log too', async () => {
    const r = await call('POST', '/api/activity', a, { kind: 'email', gig_id: ids.gig, body: 'Sent the pitch' });
    expect(r.json().contact_id).toBe(ids.priya);
    expect(r.json().gig_title).toBe('Shah wedding');
    expect((await call('GET', `/api/activity?gig_id=${ids.gig}`, a)).json().activity.some((x: { body: string }) => x.body === 'Sent the pitch')).toBe(true);
  });

  it('needs a contact or gig, a body, and only tasks have due dates', async () => {
    expect((await call('POST', '/api/activity', a, { kind: 'note', body: 'x' })).json()).toEqual({ error: 'needs_contact_or_gig' });
    expect((await call('POST', '/api/activity', a, { kind: 'note', contact_id: ids.priya, body: '  ' })).statusCode).toBe(400);
    expect((await call('POST', '/api/activity', a, { kind: 'note', contact_id: ids.priya, body: 'x', due_at: '2030-01-01T00:00:00Z' })).statusCode).toBe(400);
    expect((await call('GET', '/api/activity', a)).statusCode).toBe(400);
  });

  it('refuses another band contact and hides other bands logs', async () => {
    const other = (await call('POST', '/api/contacts', b, { first_name: 'Bee' })).json();
    expect((await call('POST', '/api/activity', a, { kind: 'note', contact_id: other.id, body: 'x' })).statusCode).toBe(400);
    expect((await call('GET', `/api/activity?contact_id=${ids.priya}`, b)).json().activity).toHaveLength(0);
  });

  it('ticks a task off and back, and a plain note cannot be completed', async () => {
    const t = (await call('POST', '/api/activity', a, { kind: 'task', contact_id: ids.priya, body: 'Send contract', due_at: '2030-01-01T17:00:00Z' })).json();
    expect(t.completed_at).toBeNull();
    const done = (await call('PATCH', `/api/activity/${t.id}`, a, { completed: true })).json();
    expect(done.completed_at).not.toBeNull();
    expect((await call('PATCH', `/api/activity/${t.id}`, a, { completed: false })).json().completed_at).toBeNull();
    const note = (await call('GET', `/api/activity?contact_id=${ids.priya}`, a)).json().activity.find((x: { kind: string }) => x.kind === 'note');
    expect((await call('PATCH', `/api/activity/${note.id}`, a, { completed: true })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/activity/${t.id}`, b, { completed: true })).statusCode).toBe(404);
    ids.task = t.id;
  });

  it('is closed to read-only members', async () => {
    expect((await call('POST', '/api/activity', viewer, { kind: 'note', contact_id: ids.priya, body: 'x' })).statusCode).toBe(403);
    expect((await call('GET', `/api/activity?contact_id=${ids.priya}`, viewer)).statusCode).toBe(200);
  });
});

describe('follow-ups', () => {
  it('lists open tasks, gigs to chase and replies owed, soonest first', async () => {
    await call('PATCH', `/api/gigs/${ids.gig}`, a, { next_action_at: '2030-02-01T18:00:00Z', reply_owed_by: '2030-01-15' });
    const done = (await call('POST', '/api/activity', a, { kind: 'task', contact_id: ids.priya, body: 'Done already', due_at: '2030-01-01T00:00:00Z' })).json();
    await call('PATCH', `/api/activity/${done.id}`, a, { completed: true });
    const f = (await call('GET', '/api/followups', a)).json();
    expect(f.tasks.map((t: { body: string }) => t.body)).toEqual(['Send contract']);
    expect(f.gigs[0].title).toBe('Shah wedding');
    expect(f.gigs[0].contact_name).toBe('Priya Shah');
    expect(f.replies[0].reply_owed_by).toBe('2030-01-15');
  });

  it('leaves out finished and archived gigs, and other bands', async () => {
    await call('PATCH', `/api/gigs/${ids.gig}`, a, { stage: 'played' });
    const f = (await call('GET', '/api/followups', a)).json();
    expect(f.gigs).toHaveLength(0);
    expect(f.replies).toHaveLength(0);
    const fb = (await call('GET', '/api/followups', b)).json();
    expect(fb).toEqual({ tasks: [], gigs: [], replies: [], payments: [], owed: [] });
  });
});

describe('templates', () => {
  it('creates, lists, edits and archives', async () => {
    const t = await call('POST', '/api/templates', a, { name: 'Polite decline', kind: 'decline', body: 'Hi {first_name}, thanks but we are booked.' });
    expect(t.statusCode).toBe(201);
    const id = t.json().id;
    expect((await call('GET', '/api/templates', a)).json().templates).toHaveLength(1);
    expect((await call('PATCH', `/api/templates/${id}`, a, { subject: 'Your date' })).json().subject).toBe('Your date');
    expect((await call('PATCH', `/api/templates/${id}`, a, { archived: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/templates', a)).json().templates).toHaveLength(0);
    ids.tpl = id;
  });

  it('refuses a repeated name, keeps bands apart, and needs a body', async () => {
    expect((await call('POST', '/api/templates', a, { name: 'Polite decline', body: 'again' })).json()).toEqual({ error: 'template_name_exists' });
    expect((await call('POST', '/api/templates', b, { name: 'Polite decline', body: 'b copy' })).statusCode).toBe(201);
    expect((await call('PATCH', `/api/templates/${ids.tpl}`, b, { name: 'steal' })).statusCode).toBe(404);
    expect((await call('POST', '/api/templates', a, { name: 'Empty', body: ' ' })).statusCode).toBe(400);
  });

  it('is closed to read-only members', async () => {
    expect((await call('POST', '/api/templates', viewer, { name: 'x', body: 'y' })).statusCode).toBe(403);
    expect((await call('GET', '/api/templates', viewer)).statusCode).toBe(200);
  });
});
