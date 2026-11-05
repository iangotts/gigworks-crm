// Public subscribe form, unsubscribe link, consent changes and the subscriber export. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, withSystem } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { formToken, unsubToken } from '../src/tokens.js';

const PASSWORD = 'correct horse battery staple';
const tag = randomBytes(4).toString('hex');
const config: Config = { ...loadConfig({ ...process.env, SCRYPT_LOG_N: '10' }), allowedOrigins: ['http://app.test'] };
const pool = createPool(config.databaseUrl);

let app: FastifyInstance;
const ids: Record<string, string> = {};
const email = (n: string): string => `itest-${tag}-s${n}@example.test`;

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

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

let a: Record<string, string>; // member in tenant A
let b: Record<string, string>; // member in tenant B
let viewer: Record<string, string>;

beforeAll(async () => {
  app = await buildApp(config, pool, { loginLimit: 1000, publicLimit: { subscribe: 1000, other: 1000 } });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [
        `Subscribe Test ${k}`, `itest-s${k.toLowerCase()}-${tag}`,
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
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-s%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-s%-${tag}`]);
  });
  await app.close();
  await pool.end();
});



const slugA = (): string => `itest-sa-${tag}`;
const slugB = (): string => `itest-sb-${tag}`;
const openForm = (slug: string, ageMs = 10_000): string => formToken(config.formSecret, slug, Date.now() - ageMs);
const pub = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const signup = (slug: string, body: object, token = openForm(slug)) =>
  pub('POST', `/api/public/band/${slug}/subscribe`, { consent: true, token, ...body });
const rowFor = (tenant: string, email: string) =>
  withSystem(pool, async (c) => {
    const r = await c.query(
      `SELECT c.id, c.source, s.status, s.consent_source FROM contact c LEFT JOIN subscription s ON s.contact_id = c.id WHERE c.tenant_id = $1 AND c.email = $2`,
      [tenant, email],
    );
    return r.rows[0] as { id: string; source: string; status: string | null; consent_source: string | null } | undefined;
  });

describe('the public subscribe form', () => {
  it('shows the band name and the wording that will be recorded', async () => {
    const r = await pub('GET', `/api/public/band/${slugA()}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().name).toBe('Subscribe Test A');
    expect(r.json().consent_text).toContain('Subscribe Test A');
    expect(r.json().token).toBeTruthy();
    expect((await pub('GET', '/api/public/band/no-such-band')).statusCode).toBe(404);
  });

  it('puts a signup in the right band only, with consent recorded and a note in the log', async () => {
    const r = await signup(slugA(), { email: ' New.Fan@Example.test ', first_name: 'Nina' });
    expect(r.statusCode).toBe(202);
    const mine = await rowFor(ids.A as string, 'new.fan@example.test');
    expect(mine).toMatchObject({ status: 'subscribed', source: 'Subscribe form', consent_source: 'Subscribe form' });
    expect(await rowFor(ids.B as string, 'new.fan@example.test')).toBeUndefined();
    const log = (await call('GET', `/api/activity?contact_id=${mine?.id}`, a)).json().activity;
    expect(log[0].body).toContain('They agreed to: Yes, email me news and gig announcements from Subscribe Test A');
  });

  it('answers the same whether or not the address is already on the list', async () => {
    const again = await signup(slugA(), { email: 'new.fan@example.test' });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ ok: true });
    const count = await withSystem(pool, (c) => c.query('SELECT count(*)::int AS n FROM contact WHERE tenant_id = $1 AND email = $2', [ids.A, 'new.fan@example.test']));
    expect(count.rows[0].n).toBe(1);
  });

  it('needs consent, a valid token, and drops robots quietly', async () => {
    expect((await signup(slugA(), { email: 'x1@example.test', consent: false })).json()).toEqual({ error: 'consent_required' });
    expect((await signup(slugA(), { email: 'x2@example.test' }, 'garbage')).json()).toEqual({ error: 'form_expired' });
    expect((await signup(slugA(), { email: 'x3@example.test' }, openForm(slugA(), 3 * 3600_000))).json()).toEqual({ error: 'form_expired' });
    expect((await signup(slugA(), { email: 'x4@example.test' }, openForm(slugB()))).json()).toEqual({ error: 'form_expired' }); // a token for another band
    const robot = await signup(slugA(), { email: 'bot1@example.test', website: 'http://spam.example' });
    const fast = await signup(slugA(), { email: 'bot2@example.test' }, openForm(slugA(), 200));
    expect(robot.statusCode).toBe(202);
    expect(fast.statusCode).toBe(202);
    for (const e of ['x1', 'x2', 'x3', 'x4', 'bot1', 'bot2']) expect(await rowFor(ids.A as string, `${e}@example.test`)).toBeUndefined();
  });

  it('ignores a bad address without saying so, and a band that does not exist', async () => {
    expect((await signup(slugA(), { email: 'not-an-email' })).statusCode).toBe(202);
    expect(await rowFor(ids.A as string, 'not-an-email')).toBeUndefined();
    const missing = await pub('POST', '/api/public/band/no-such-band/subscribe', { email: 'a@b.test', consent: true, token: openForm('no-such-band') });
    expect(missing.statusCode).toBe(202);
  });

  it('adds consent to an existing contact, and never puts back someone who unsubscribed', async () => {
    const c = (await call('POST', '/api/contacts', a, { first_name: 'Old', email: 'old.contact@example.test' })).json();
    expect((await signup(slugA(), { email: 'old.contact@example.test' })).statusCode).toBe(202);
    expect((await rowFor(ids.A as string, 'old.contact@example.test'))?.status).toBe('subscribed');
    await call('PUT', `/api/contacts/${c.id}/subscription`, a, { status: 'unsubscribed' });
    await signup(slugA(), { email: 'old.contact@example.test' });
    expect((await rowFor(ids.A as string, 'old.contact@example.test'))?.status).toBe('unsubscribed');
    const log = (await call('GET', `/api/activity?contact_id=${c.id}`, a)).json().activity;
    expect(log[0].body).toContain('marked unsubscribed');
  });
});

describe('the unsubscribe link', () => {
  let token = '';
  let contactId = '';
  it('shows who it is for without a full address, and changes nothing on a visit', async () => {
    const r = await rowFor(ids.A as string, 'new.fan@example.test');
    contactId = r?.id as string;
    token = unsubToken(config.formSecret, contactId);
    const info = await pub('GET', `/api/public/unsubscribe/${token}`);
    expect(info.json()).toEqual({ band: 'Subscribe Test A', email: 'n***@example.test', status: 'subscribed' });
    expect((await rowFor(ids.A as string, 'new.fan@example.test'))?.status).toBe('subscribed');
  });

  it('unsubscribes on the post, once, and notes it', async () => {
    expect((await pub('POST', `/api/public/unsubscribe/${token}`)).json()).toEqual({ status: 'unsubscribed' });
    expect((await pub('POST', `/api/public/unsubscribe/${token}`)).json()).toEqual({ status: 'unsubscribed' });
    expect((await rowFor(ids.A as string, 'new.fan@example.test'))?.status).toBe('unsubscribed');
    const log = (await call('GET', `/api/activity?contact_id=${contactId}`, a)).json().activity;
    expect(log.filter((x: { body: string }) => x.body.startsWith('Unsubscribed through the link'))).toHaveLength(1);
  });

  it('can be undone from the same link, but not for a bounced address', async () => {
    expect((await pub('POST', `/api/public/resubscribe/${token}`)).json()).toEqual({ status: 'subscribed' });
    await call('PUT', `/api/contacts/${contactId}/subscription`, a, { status: 'bounced' });
    expect((await pub('POST', `/api/public/resubscribe/${token}`)).json()).toEqual({ status: 'bounced' });
  });

  it('refuses a forged, edited or unknown link', async () => {
    const [id, mac] = token.split('.');
    for (const bad of ['nope', `${id}.${'x'.repeat(32)}`, `${(id as string).replace(/^./, '0')}.${mac}`, `${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.${mac}`]) {
      expect((await pub('GET', `/api/public/unsubscribe/${bad}`)).statusCode).toBe(404);
      expect((await pub('POST', `/api/public/unsubscribe/${bad}`)).statusCode).toBe(404);
    }
  });

  it('works for a contact of the other band and does not touch this one', async () => {
    const cb = (await call('POST', '/api/contacts', b, { first_name: 'Bee', email: 'bee@example.test' })).json();
    await call('PUT', `/api/contacts/${cb.id}/subscription`, b, { status: 'subscribed', consent_source: 'At the gig' });
    const t = unsubToken(config.formSecret, cb.id);
    expect((await pub('POST', `/api/public/unsubscribe/${t}`)).json()).toEqual({ status: 'unsubscribed' });
    expect((await rowFor(ids.B as string, 'bee@example.test'))?.status).toBe('unsubscribed');
  });
});

describe('changing consent by hand', () => {
  let id = '';
  it('needs an email, and a note of where they agreed', async () => {
    const noEmail = (await call('POST', '/api/contacts', a, { first_name: 'No Email' })).json();
    expect((await call('PUT', `/api/contacts/${noEmail.id}/subscription`, a, { status: 'unsubscribed' })).json()).toEqual({ error: 'needs_email' });
    id = (await call('POST', '/api/contacts', a, { first_name: 'Hand', email: 'hand@example.test' })).json().id;
    expect((await call('PUT', `/api/contacts/${id}/subscription`, a, { status: 'subscribed' })).json()).toEqual({ error: 'needs_consent_source' });
    const ok = await call('PUT', `/api/contacts/${id}/subscription`, a, { status: 'subscribed', consent_source: 'Gave her email at the 1 Nov gig' });
    expect(ok.json()).toMatchObject({ status: 'subscribed', consent_source: 'Gave her email at the 1 Nov gig' });
    const detail = (await call('GET', `/api/contacts/${id}`, a)).json();
    expect(detail.contact.consent.status).toBe('subscribed');
    const log = (await call('GET', `/api/activity?contact_id=${id}`, a)).json().activity;
    expect(log[0].body).toContain('Gave her email at the 1 Nov gig');
    expect(log[0].by_name).toBe('a');
  });

  it('records an unsubscribe and keeps the original consent note', async () => {
    const r = (await call('PUT', `/api/contacts/${id}/subscription`, a, { status: 'unsubscribed' })).json();
    expect(r.status).toBe('unsubscribed');
    expect(r.unsubscribed_at).not.toBeNull();
    expect(r.consent_source).toBe('Gave her email at the 1 Nov gig');
  });

  it('keeps bands apart and closes to read-only members', async () => {
    expect((await call('PUT', `/api/contacts/${id}/subscription`, b, { status: 'suppressed' })).statusCode).toBe(404);
    expect((await call('PUT', `/api/contacts/${id}/subscription`, viewer, { status: 'suppressed' })).statusCode).toBe(403);
  });
});

describe('the subscriber export', () => {
  const csvLines = (text: string): string[] => text.trim().split('\r\n');
  const seed = async (): Promise<void> => {
    const make = async (email: string, extra: object, status: string | null, roles: string[] = []) => {
      const c = (await call('POST', '/api/contacts', a, { email, ...extra })).json();
      if (status === 'subscribed') await call('PUT', `/api/contacts/${c.id}/subscription`, a, { status, consent_source: 'test' });
      else if (status) await call('PUT', `/api/contacts/${c.id}/subscription`, a, { status });
      for (const kind of roles) await withSystem(pool, (q) => q.query('INSERT INTO contact_role (tenant_id, contact_id, kind) VALUES ($1, $2, $3)', [ids.A, c.id, kind]));
      if ('local' in extra) await withSystem(pool, (q) => q.query('UPDATE contact SET is_local = $2 WHERE id = $1', [c.id, (extra as { local: boolean }).local]));
      return c.id as string;
    };
    await make('exp-yes-local@example.test', { first_name: '=cmd', local: true, tags: ['wedding'] }, 'subscribed', ['client']);
    await make('exp-yes-far@example.test', { first_name: 'Far, Away', local: false, tags: ['festival'] }, 'subscribed', ['organizer']);
    await make('exp-unsub@example.test', {}, 'unsubscribed');
    await make('exp-bounced@example.test', {}, 'bounced');
    await make('exp-never@example.test', {}, null);
    const archived = await make('exp-archived@example.test', {}, 'subscribed');
    await call('PATCH', `/api/contacts/${archived}`, a, { archived: true });
  };

  it('lists only people who said yes, as a file with a safe unsubscribe link each', async () => {
    await seed();
    const r = await call('GET', '/api/export/subscribers?format=csv', a);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="itest-sa-[0-9a-f]+-subscribed-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csvLines(r.body);
    const emails = lines.slice(1).map((l) => l.split(',')[0]);
    expect(emails).toContain('exp-yes-local@example.test');
    expect(emails).toContain('exp-yes-far@example.test');
    for (const no of ['exp-unsub', 'exp-bounced', 'exp-never', 'exp-archived']) expect(emails.join(' ')).not.toContain(no);
    expect(lines[0]).toBe('email,first_name,last_name,company,city,local,tags,roles,status,unsubscribe_url');
    const mine = lines.find((l) => l.startsWith('exp-yes-local')) as string;
    expect(mine).toContain("'=cmd"); // a formula is defused
    const url = mine.split(',').pop() as string;
    expect(url.startsWith(config.publicUrl + '/unsubscribe/')).toBe(true);
    const unsub = await pub('GET', `/api/public/unsubscribe/${url.split('/unsubscribe/')[1]}`);
    expect(unsub.json().email).toMatch(/^e\*\*\*@example\.test$/);
    expect(r.body).not.toContain('Subscribe Test B');
  });

  it('filters by role, local and tag, and can list the unsubscribed for a suppression list', async () => {
    const get = async (q: string) => (await call('GET', `/api/export/subscribers?${q}`, a)).json();
    expect((await get('role=client&format=json')).count).toBe(1);
    expect((await get('local=yes&format=json')).count).toBe(1);
    expect((await get('local=no&format=json')).count).toBe(1);
    expect((await get('tag=festival&format=json')).count).toBe(1);
    expect((await get('tag=wedding&role=organizer&format=json')).count).toBe(0);
    const unsub = await get('status=unsubscribed&format=json');
    expect(unsub.sample.map((r: { email: string }) => r.email)).toContain('exp-unsub@example.test');
    expect((await call('GET', '/api/export/subscribers?status=everyone', a)).statusCode).toBe(400);
  });

  it('is closed to read-only members and never shows another band', async () => {
    expect((await call('GET', '/api/export/subscribers?format=csv', viewer)).statusCode).toBe(403);
    const other = (await call('GET', '/api/export/subscribers?format=csv', b)).body;
    expect(other).not.toContain('example.test,Nina');
    expect(other).not.toContain('exp-yes-local');
  });

  it('counts each state for the Subscribers panel', async () => {
    const s = (await call('GET', '/api/subscribers/summary', a)).json();
    expect(s).toMatchObject({ unsubscribed: expect.any(Number), no_consent: expect.any(Number) });
    expect(s.subscribed).toBeGreaterThanOrEqual(2);
    expect(s.bounced).toBeGreaterThanOrEqual(1);
    expect(s.subscribe_url).toBe(`${config.publicUrl}/subscribe/itest-sa-${tag}`);
    expect((await call('GET', '/api/subscribers/summary', viewer)).statusCode).toBe(200);
  });
});
