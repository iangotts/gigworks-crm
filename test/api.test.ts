// API tests against a real Postgres. They need DATABASE_URL (the owner login) and a database
// that has had `npm run db:migrate` applied. They create their own tenants and users and
// remove them again at the end.
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
const email = (n: string): string => `itest-${tag}-${n}@example.test`;

async function makeUser(name: string, memberships: [string, string][], opts: { active?: boolean } = {}): Promise<void> {
  const hash = await hashPassword(PASSWORD, 10);
  await withSystem(pool, async (c) => {
    const u = await c.query<{ id: string }>(
      'INSERT INTO app_user (email, name, password_hash, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
      [email(name), name, hash, opts.active ?? true],
    );
    ids[name] = (u.rows[0] as { id: string }).id;
    for (const [tenant, role] of memberships) {
      await c.query('INSERT INTO membership (tenant_id, user_id, role) VALUES ($1, $2, $3)', [ids[tenant], ids[name], role]);
    }
  });
}

async function login(name: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: email(name), password } });
  const cookie = res.cookies.find((c) => c.name === 'gwcrm_session');
  const headers: Record<string, string> = cookie ? { cookie: `gwcrm_session=${cookie.value}` } : {};
  return { res, headers };
}

const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  // Many logins come from one address in these tests, so the limit is lifted here and tested separately.
  app = await buildApp(config, pool, { loginLimit: 1000 });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [
        `Test ${k}`,
        `itest-${k.toLowerCase()}-${tag}`,
      ]);
      ids[k] = (t.rows[0] as { id: string }).id;
    }
    await c.query('INSERT INTO contact (tenant_id, first_name, last_name, email) VALUES ($1, $2, $3, $4)', [
      ids.B, 'Bee', 'Only', 'bee@example.test',
    ]);
  });
  await makeUser('both', [['A', 'admin'], ['B', 'admin']]);
  await makeUser('solo', [['A', 'member']]);
  await makeUser('viewer', [['A', 'read_only']]);
  await makeUser('gone', [['A', 'member']], { active: false });
  await makeUser('nobody', []);
});

afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-%-${tag}`]);
  });
  await app.close();
  await pool.end();
});

describe('login', () => {
  it('answers the same for a wrong password, an unknown email and a disabled user', async () => {
    const wrong = await login('solo', 'not the password');
    const unknown = await app.inject({
      method: 'POST', url: '/api/login', payload: { email: `nobody-${tag}@example.test`, password: PASSWORD },
    });
    const disabled = await login('gone');
    for (const r of [wrong.res, unknown, disabled.res]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid_credentials' });
    }
  });

  it('goes straight into the only tenant for a one-band user', async () => {
    const { res, headers } = await login('solo');
    expect(res.statusCode).toBe(200);
    expect(res.json().activeTenantId).toBe(ids.A);
    const cookie = res.cookies.find((c) => c.name === 'gwcrm_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    const me = await get('/api/me', headers);
    expect(me.json().role).toBe('member');
  });

  it('makes a two-band user choose, and refuses data until they do', async () => {
    const { res, headers } = await login('both');
    expect(res.json().activeTenantId).toBeNull();
    expect(res.json().tenants).toHaveLength(2);
    const list = await get('/api/contacts', headers);
    expect(list.statusCode).toBe(409);
    expect(list.json()).toEqual({ error: 'no_active_tenant' });
  });

  it('refuses everything without a session', async () => {
    expect((await get('/api/me', {})).statusCode).toBe(401);
    expect((await get('/api/contacts', {})).statusCode).toBe(401);
    expect((await post('/api/contacts', {}, { first_name: 'x' })).statusCode).toBe(401);
  });

  it('ends the session on logout', async () => {
    const { headers } = await login('solo');
    expect((await post('/api/logout', headers, {})).statusCode).toBe(204);
    expect((await get('/api/me', headers)).statusCode).toBe(401);
  });

  it('rate limits repeated login attempts', async () => {
    const limited = await buildApp(config, pool, { loginLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limited.inject({
        method: 'POST', url: '/api/login', payload: { email: email('solo'), password: 'wrong' },
      });
      codes.push(r.statusCode);
    }
    await limited.close();
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('tenant switching and isolation', () => {
  it('refuses a tenant the user does not belong to', async () => {
    const { headers } = await login('solo');
    const r = await post('/api/session/tenant', headers, { tenantId: ids.B });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'not_a_member' });
  });

  it('keeps each band\'s contacts separate for the same login', async () => {
    const { headers } = await login('both');
    await post('/api/session/tenant', headers, { tenantId: ids.A });
    const made = await post('/api/contacts', headers, { first_name: 'Ay', last_name: 'Contact', email: 'ay@example.test' });
    expect(made.statusCode).toBe(201);

    const inA = (await get('/api/contacts', headers)).json().contacts as { email: string }[];
    expect(inA.map((c) => c.email)).toEqual(['ay@example.test']);

    await post('/api/session/tenant', headers, { tenantId: ids.B });
    const inB = (await get('/api/contacts', headers)).json().contacts as { email: string }[];
    expect(inB.map((c) => c.email)).toEqual(['bee@example.test']);
  });

  it('ignores a tenant_id sent in the body', async () => {
    const { headers } = await login('solo');
    const r = await post('/api/contacts', headers, { first_name: 'Sneaky', tenant_id: ids.B });
    expect(r.statusCode).toBe(201);
    const row = await withSystem(pool, (c) =>
      c.query<{ tenant_id: string }>('SELECT tenant_id FROM contact WHERE id = $1', [r.json().id]),
    );
    expect(row.rows[0]?.tenant_id).toBe(ids.A);
  });

  it('rejects a duplicate email in the same band with 409', async () => {
    const { headers } = await login('solo');
    await post('/api/contacts', headers, { first_name: 'One', email: 'dup@example.test' });
    const again = await post('/api/contacts', headers, { first_name: 'Two', email: 'DUP@example.test' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'email_exists' });
  });

  it('searches within the band only', async () => {
    const { headers } = await login('both');
    await post('/api/session/tenant', headers, { tenantId: ids.A });
    const hit = (await get('/api/contacts?q=ay%40example', headers)).json().contacts as unknown[];
    expect(hit).toHaveLength(1);
    const miss = (await get('/api/contacts?q=bee', headers)).json().contacts as unknown[];
    expect(miss).toHaveLength(0);
  });
});

describe('roles and membership changes', () => {
  it('lets a read-only member read but not write', async () => {
    const { headers } = await login('viewer');
    expect((await get('/api/contacts', headers)).statusCode).toBe(200);
    const r = await post('/api/contacts', headers, { first_name: 'Nope' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'read_only' });
  });

  it('applies a role change on the very next request', async () => {
    const { headers } = await login('solo');
    expect((await post('/api/contacts', headers, { first_name: 'Before' })).statusCode).toBe(201);
    await withSystem(pool, (c) =>
      c.query("UPDATE membership SET role = 'read_only' WHERE user_id = $1 AND tenant_id = $2", [ids.solo, ids.A]),
    );
    expect((await post('/api/contacts', headers, { first_name: 'After' })).statusCode).toBe(403);
    await withSystem(pool, (c) =>
      c.query("UPDATE membership SET role = 'member' WHERE user_id = $1 AND tenant_id = $2", [ids.solo, ids.A]),
    );
  });

  it('drops access when a member is removed from the band', async () => {
    const { headers } = await login('both');
    await post('/api/session/tenant', headers, { tenantId: ids.B });
    expect((await get('/api/contacts', headers)).statusCode).toBe(200);
    await withSystem(pool, (c) => c.query('DELETE FROM membership WHERE user_id = $1 AND tenant_id = $2', [ids.both, ids.B]));
    const after = await get('/api/contacts', headers);
    expect(after.statusCode).toBe(409);
    expect(after.json()).toEqual({ error: 'no_active_tenant' });
    await withSystem(pool, (c) =>
      c.query("INSERT INTO membership (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [ids.B, ids.both]),
    );
  });

  it('shows a user with no bands nothing', async () => {
    const { res, headers } = await login('nobody');
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants).toEqual([]);
    expect((await get('/api/contacts', headers)).statusCode).toBe(409);
  });

  it('stops a disabled user\'s existing session', async () => {
    const { headers } = await login('solo');
    await withSystem(pool, (c) => c.query('UPDATE app_user SET is_active = false WHERE id = $1', [ids.solo]));
    expect((await get('/api/me', headers)).statusCode).toBe(401);
    await withSystem(pool, (c) => c.query('UPDATE app_user SET is_active = true WHERE id = $1', [ids.solo]));
  });
});

describe('request safety', () => {
  it('refuses a changing request from an unknown origin', async () => {
    const { headers } = await login('solo');
    const r = await post('/api/contacts', { ...headers, origin: 'http://evil.test' }, { first_name: 'x' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'bad_origin' });
    const ok = await post('/api/contacts', { ...headers, origin: 'http://app.test' }, { first_name: 'fine' });
    expect(ok.statusCode).toBe(201);
  });

  it('rejects a malformed body with 400', async () => {
    const { headers } = await login('solo');
    const r = await post('/api/contacts', headers, { email: 'not an email' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_request');
  });

  it('does not store the session token in the database', async () => {
    const { res } = await login('solo');
    const token = res.cookies.find((c) => c.name === 'gwcrm_session')?.value ?? '';
    const found = await withSystem(pool, (c) => c.query('SELECT 1 FROM session WHERE id = $1', [token]));
    expect(found.rowCount).toBe(0);
  });
});
