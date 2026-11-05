// Link targets, tagged links and clicks API tests. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
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
const email = (n: string): string => `itest-${tag}-l${n}@example.test`;

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
        `Link Test ${k}`, `itest-l${k.toLowerCase()}-${tag}`,
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
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-l%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-l%-${tag}`]);
  });
  await app.close();
  await pool.end();
});



const mkContact = async (who: Record<string, string>, first: string) => (await call('POST', '/api/contacts', who, { first_name: first })).json();

describe('link targets', () => {
  it('adds, lists with counts, edits and deactivates', async () => {
    const t = await call('POST', '/api/link-targets', a, { name: 'Promo video', url: 'https://janeblonde.example/video?x=1' });
    expect(t.statusCode).toBe(201);
    ids.target = t.json().id;
    const list = (await call('GET', '/api/link-targets', a)).json().targets;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Promo video', sent: 0, clicks: 0, active: true });
    expect((await call('PATCH', `/api/link-targets/${ids.target}`, a, { name: 'Promo reel' })).json().name).toBe('Promo reel');
    expect((await call('PATCH', `/api/link-targets/${ids.target}`, a, { active: false })).json().active).toBe(false);
    await call('PATCH', `/api/link-targets/${ids.target}`, a, { active: true });
  });

  it('refuses addresses that are not web addresses, keeps bands apart, closes to read-only', async () => {
    expect((await call('POST', '/api/link-targets', a, { name: 'x', url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await call('POST', '/api/link-targets', a, { name: '', url: 'https://x.test' })).statusCode).toBe(400);
    expect((await call('GET', '/api/link-targets', b)).json().targets).toHaveLength(0);
    expect((await call('PATCH', `/api/link-targets/${ids.target}`, b, { name: 'steal' })).statusCode).toBe(404);
    expect((await call('POST', '/api/link-targets', viewer, { name: 'x', url: 'https://x.test' })).statusCode).toBe(403);
    expect((await call('GET', '/api/link-targets', viewer)).statusCode).toBe(200);
  });
});

describe('building links', () => {
  it('tags a saved link, stores it, and notes it in the activity log', async () => {
    const c = await mkContact(a, 'Priya');
    ids.contact = c.id;
    const r = await call('POST', '/api/links', a, {
      contact_id: c.id, link_target_id: ids.target, utm_source: 'Jane Blonde', utm_medium: 'Email', utm_campaign: 'Smith Wedding', utm_content: 'promo-video',
    });
    expect(r.statusCode).toBe(201);
    const l = r.json();
    expect(l.destination_url).toBe(
      'https://janeblonde.example/video?x=1&utm_source=jane-blonde&utm_medium=email&utm_campaign=smith-wedding&utm_content=promo-video',
    );
    expect(l.target_name).toBe('Promo reel');
    expect(l.clicks).toBe(0);
    expect(l.destination_url).not.toContain(c.id); // no identifier in the address
    const log = (await call('GET', `/api/activity?contact_id=${c.id}`, a)).json().activity;
    expect(log[0].body).toContain('Link prepared: Promo reel');
    expect((await call('GET', '/api/link-targets', a)).json().targets[0].sent).toBe(1);
  });

  it('takes the contact from the gig, and accepts a one-off address', async () => {
    const g = (await call('POST', '/api/gigs', a, { title: 'Shah wedding', contact_id: ids.contact })).json();
    ids.gig = g.id;
    const r = await call('POST', '/api/links', a, { gig_id: g.id, url: 'https://other.example', utm_source: 's', utm_medium: 'text' });
    expect(r.statusCode).toBe(201);
    expect(r.json().contact_id).toBe(ids.contact);
    expect(r.json().link_target_id).toBeNull();
    expect((await call('GET', `/api/links?gig_id=${g.id}`, a)).json().links).toHaveLength(1);
    expect((await call('GET', `/api/links?contact_id=${ids.contact}`, a)).json().links).toHaveLength(2);
  });

  it('needs a source, a medium, a contact or gig, and a link or address', async () => {
    const base = { contact_id: ids.contact, link_target_id: ids.target, utm_source: 's', utm_medium: 'm' };
    expect((await call('POST', '/api/links', a, { ...base, utm_source: ' ' })).statusCode).toBe(400);
    expect((await call('POST', '/api/links', a, { ...base, utm_medium: '' })).statusCode).toBe(400);
    expect((await call('POST', '/api/links', a, { ...base, contact_id: null })).json()).toEqual({ error: 'needs_contact_or_gig' });
    expect((await call('POST', '/api/links', a, { ...base, link_target_id: null })).json()).toEqual({ error: 'needs_link_or_url' });
    expect((await call('POST', '/api/links', a, { ...base, link_target_id: null, url: 'ftp://x.test' })).statusCode).toBe(400);
    expect((await call('GET', '/api/links', a)).statusCode).toBe(400);
  });

  it('refuses another band contact or link, and the read-only member', async () => {
    const other = await mkContact(b, 'Bee');
    const tb = (await call('POST', '/api/link-targets', b, { name: 'B site', url: 'https://b.example' })).json();
    const mine = { utm_source: 's', utm_medium: 'm' };
    expect((await call('POST', '/api/links', a, { ...mine, contact_id: other.id, link_target_id: ids.target })).statusCode).toBe(400);
    expect((await call('POST', '/api/links', a, { ...mine, contact_id: ids.contact, link_target_id: tb.id })).json()).toEqual({ error: 'unknown_link_target' });
    expect((await call('POST', '/api/links', viewer, { ...mine, contact_id: ids.contact, link_target_id: ids.target })).statusCode).toBe(403);
    expect((await call('GET', `/api/links?contact_id=${ids.contact}`, b)).json().links).toHaveLength(0);
  });
});

describe('clicks', () => {
  it('records a click by hand and counts it', async () => {
    const link = (await call('GET', `/api/links?contact_id=${ids.contact}`, a)).json().links.find((x: { link_target_id: string | null }) => x.link_target_id);
    const r = await call('POST', `/api/links/${link.id}/clicks`, a, {});
    expect(r.statusCode).toBe(201);
    expect(r.json().clicks).toBe(1);
    const again = await call('POST', `/api/links/${link.id}/clicks`, a, { clicked_at: '2026-11-01T10:00:00Z' });
    expect(again.json().clicks).toBe(2);
    const row = await withSystem(pool, (c) => c.query("SELECT origin FROM link_click WHERE outbound_link_id = $1", [link.id]));
    expect(row.rows.every((x: { origin: string }) => x.origin === 'manual')).toBe(true);
    const t = (await call('GET', '/api/link-targets', a)).json().targets.find((x: { id: string }) => x.id === ids.target);
    expect(t.clicks).toBe(2);
  });

  it('is closed to other bands and the read-only member', async () => {
    const link = (await call('GET', `/api/links?contact_id=${ids.contact}`, a)).json().links[0];
    expect((await call('POST', `/api/links/${link.id}/clicks`, b, {})).statusCode).toBe(404);
    expect((await call('POST', `/api/links/${link.id}/clicks`, viewer, {})).statusCode).toBe(403);
  });
});
