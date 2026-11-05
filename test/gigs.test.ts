// Gig pipeline API tests. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
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
const email = (n: string): string => `itest-${tag}-g${n}@example.test`;

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
        `Gig Test ${k}`, `itest-g${k.toLowerCase()}-${tag}`,
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
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-g%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-g%-${tag}`]);
  });
  await app.close();
  await pool.end();
});

describe('creating gigs', () => {
  it('creates a gig with a lead block and returns the date as plain text', async () => {
    const r = await call('POST', '/api/gigs', a, {
      title: 'Marin County Fair', event_date: '2027-07-04', stage: 'evaluating', platform: 'Bark',
      budget: '2500', hours: 3, indoor_outdoor: 'outdoor', tenant_id: ids.B,
    });
    expect(r.statusCode).toBe(201);
    const g = r.json();
    expect(g.stage).toBe('evaluating');
    expect(g.event_date).toBe('2027-07-04');
    expect(g.budget).toBe('2500.00');
    const row = await withSystem(pool, (c) => c.query('SELECT tenant_id FROM gig WHERE id = $1', [g.id]));
    expect(row.rows[0]?.tenant_id).toBe(ids.A); // the tenant_id in the body was ignored
  });

  it('needs a title and rejects a bad date', async () => {
    expect((await call('POST', '/api/gigs', a, { stage: 'new' })).statusCode).toBe(400);
    expect((await call('POST', '/api/gigs', a, { title: 'x', event_date: '07/04/2027' })).statusCode).toBe(400);
  });

  it('refuses a contact or venue that belongs to another band', async () => {
    const r = await call('POST', '/api/gigs', a, { title: 'Cross', contact_id: ids.contactB });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'unknown_contact_or_venue' });
    const v = await call('POST', '/api/gigs', a, { title: 'Cross', venue_id: ids.venueB });
    expect(v.statusCode).toBe(400);
  });

  it('is closed to read-only members', async () => {
    const r = await call('POST', '/api/gigs', viewer, { title: 'Nope' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'read_only' });
  });
});

describe('the pipeline list', () => {
  it('shows each band only its own gigs', async () => {
    await call('POST', '/api/gigs', b, { title: 'B only gig' });
    const listA = (await call('GET', '/api/gigs', a)).json().gigs as { title: string }[];
    const listB = (await call('GET', '/api/gigs', b)).json().gigs as { title: string }[];
    expect(listA.map((g) => g.title)).toContain('Marin County Fair');
    expect(listA.map((g) => g.title)).not.toContain('B only gig');
    expect(listB.map((g) => g.title)).toEqual(['B only gig']);
  });

  it('joins the contact and venue names for the card', async () => {
    const c = await call('POST', '/api/contacts', a, { first_name: 'Dana', last_name: 'Lee', email: `dana-${tag}@example.test` });
    const v = await call('POST', '/api/venues', a, { name: 'The Fillmore', city: 'San Francisco' });
    expect(v.statusCode).toBe(201);
    const g = await call('POST', '/api/gigs', a, { title: 'Fillmore night', contact_id: c.json().id, venue_id: v.json().id });
    expect(g.json().contact_name).toBe('Dana Lee');
    expect(g.json().venue_name).toBe('The Fillmore');
  });

  it('searches by title, venue or contact', async () => {
    const hit = (await call('GET', '/api/gigs?q=fillmore', a)).json().gigs as unknown[];
    expect(hit).toHaveLength(1);
    const byContact = (await call('GET', '/api/gigs?q=dana', a)).json().gigs as unknown[];
    expect(byContact).toHaveLength(1);
    expect((await call('GET', '/api/gigs?q=nothing-matches', a)).json().gigs).toHaveLength(0);
  });

  it('orders by date with undated gigs last', async () => {
    await call('POST', '/api/gigs', a, { title: 'Early', event_date: '2026-12-01' });
    const titles = ((await call('GET', '/api/gigs', a)).json().gigs as { title: string }[]).map((g) => g.title);
    expect(titles.indexOf('Early')).toBeLessThan(titles.indexOf('Marin County Fair'));
    expect(titles.indexOf('Marin County Fair')).toBeLessThan(titles.indexOf('Fillmore night'));
  });
});

describe('moving and editing a gig', () => {
  let gigId = '';
  beforeAll(async () => {
    gigId = (await call('POST', '/api/gigs', a, { title: 'Moving gig' })).json().id;
  });

  it('moves a gig to a new stage and logs it in the history', async () => {
    const r = await call('PATCH', `/api/gigs/${gigId}`, a, { stage: 'in_conversation' });
    expect(r.statusCode).toBe(200);
    expect(r.json().stage).toBe('in_conversation');
    const detail = (await call('GET', `/api/gigs/${gigId}`, a)).json();
    expect(detail.activity[0].body).toBe('Stage changed: New to In conversation');
  });

  it('keeps postponed only on confirmed gigs', async () => {
    expect((await call('PATCH', `/api/gigs/${gigId}`, a, { postponed: true })).statusCode).toBe(400);
    await call('PATCH', `/api/gigs/${gigId}`, a, { stage: 'confirmed' });
    expect((await call('PATCH', `/api/gigs/${gigId}`, a, { postponed: true })).json().postponed).toBe(true);
    const back = await call('PATCH', `/api/gigs/${gigId}`, a, { stage: 'played' });
    expect(back.json().postponed).toBe(false);
  });

  it('records a lost reason and clears it when the gig comes back', async () => {
    await call('PATCH', `/api/gigs/${gigId}`, a, { stage: 'lost', lost_reason: 'Budget too low' });
    const lost = (await call('GET', `/api/gigs/${gigId}`, a)).json().gig;
    expect(lost.lost_reason).toBe('Budget too low');
    await call('PATCH', `/api/gigs/${gigId}`, a, { stage: 'new' });
    expect((await call('GET', `/api/gigs/${gigId}`, a)).json().gig.lost_reason).toBeNull();
  });

  it('updates lead fields and clears one with an empty value', async () => {
    const r = await call('PATCH', `/api/gigs/${gigId}`, a, { fee_quoted: 1800, fee_note: '+ travel', platform: 'GigSalad' });
    expect(r.json().fee_quoted).toBe('1800.00');
    const cleared = await call('PATCH', `/api/gigs/${gigId}`, a, { fee_note: '' });
    expect(cleared.json().fee_note).toBeNull();
  });

  it('rejects an empty change', async () => {
    expect((await call('PATCH', `/api/gigs/${gigId}`, a, {})).statusCode).toBe(400);
  });

  it('hides an archived gig from the list', async () => {
    await call('PATCH', `/api/gigs/${gigId}`, a, { archived: true });
    const titles = ((await call('GET', '/api/gigs', a)).json().gigs as { title: string }[]).map((g) => g.title);
    expect(titles).not.toContain('Moving gig');
  });

  it('cannot see, change or move another band\'s gig', async () => {
    const other = (await call('POST', '/api/gigs', b, { title: 'Private to B' })).json().id as string;
    expect((await call('GET', `/api/gigs/${other}`, a)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/gigs/${other}`, a, { stage: 'lost' })).statusCode).toBe(404);
    const still = await withSystem(pool, (c) => c.query('SELECT stage FROM gig WHERE id = $1', [other]));
    expect(still.rows[0]?.stage).toBe('new');
  });

  it('is closed to read-only members', async () => {
    expect((await call('PATCH', `/api/gigs/${gigId}`, viewer, { stage: 'lost' })).statusCode).toBe(403);
  });
});
