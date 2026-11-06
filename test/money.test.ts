// Money: fee, deposit and balance, mark paid, owed lists, testimonial reminder. Real Postgres, own tenants and users, cleaned up after.
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
const email = (n: string): string => `itest-${tag}-m${n}@example.test`;

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


let a: Record<string, string>;
let viewer: Record<string, string>;
let b: Record<string, string>;
let contactId = '';
const mkGig = async (o: object = {}): Promise<string> =>
  (await call('POST', '/api/gigs', a, { title: 'Smith wedding', stage: 'confirmed', event_date: '2026-12-05', fee_quoted: 3333.33, contact_id: contactId, ...o })).json().id;
const money = async (id: string) => (await call('GET', `/api/gigs/${id}/money`, a)).json();

beforeAll(async () => {
  app = await buildApp(config, pool, { loginLimit: 1000 });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [`Money Test ${k}`, `itest-m${k.toLowerCase()}-${tag}`]);
      ids[k] = (t.rows[0] as { id: string }).id;
    }
    const ct = await c.query<{ id: string }>("INSERT INTO contact (tenant_id, first_name, last_name) VALUES ($1, 'Sam', 'Smith') RETURNING id", [ids.A]);
    contactId = (ct.rows[0] as { id: string }).id;
  });
  await makeUser('a', 'A', 'admin');
  await makeUser('viewer', 'A', 'read_only');
  await makeUser('b', 'B', 'admin');
  [a, viewer, b] = await Promise.all([login('a'), login('viewer'), login('b')]);
});

afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-m%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-m%-${tag}`]);
  });
  await app.close();
  await pool.end();
});

describe('payment plan', () => {
  it('splits an odd fee so deposit and balance add up exactly', async () => {
    const id = await mkGig();
    const r = await call('POST', `/api/gigs/${id}/payments/plan`, a, { deposit_percent: 50 });
    expect(r.statusCode).toBe(201);
    const m = r.json();
    const amounts = Object.fromEntries(m.payments.map((p: { kind: string; amount: string }) => [p.kind, p.amount]));
    expect(amounts.deposit).toBe('1666.67');
    expect(amounts.balance).toBe('1666.66');
    expect(m.scheduled).toBe('3333.33');
    expect(m.fee).toBe('3333.33');
    expect(m.state).toBe('unpaid');
    expect(m.schedule_gap).toBeNull();
    const bal = m.payments.find((p: { kind: string }) => p.kind === 'balance');
    expect(bal.due_on).toBe('2026-12-05');
  });
  it('refuses without a fee, or when payments already exist', async () => {
    const nofee = await mkGig({ fee_quoted: null });
    expect((await call('POST', `/api/gigs/${nofee}/payments/plan`, a, {})).json().error).toBe('no_fee');
    const id = await mkGig();
    await call('POST', `/api/gigs/${id}/payments/plan`, a, {});
    const again = await call('POST', `/api/gigs/${id}/payments/plan`, a, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('payments_exist');
  });
  it('rejects a deposit percent outside 1 to 99', async () => {
    const id = await mkGig();
    expect((await call('POST', `/api/gigs/${id}/payments/plan`, a, { deposit_percent: 0 })).statusCode).toBe(400);
    expect((await call('POST', `/api/gigs/${id}/payments/plan`, a, { deposit_percent: 100 })).statusCode).toBe(400);
  });
});

describe('Confirmed to Paid', () => {
  it('moves unpaid, part paid, paid, and overpaid as money comes in', async () => {
    const id = await mkGig({ fee_quoted: 1000 });
    const plan = (await call('POST', `/api/gigs/${id}/payments/plan`, a, { deposit_percent: 30 })).json();
    const dep = plan.payments.find((p: { kind: string }) => p.kind === 'deposit');
    const bal = plan.payments.find((p: { kind: string }) => p.kind === 'balance');
    expect(dep.amount).toBe('300.00');
    expect(bal.amount).toBe('700.00');
    expect((await money(id)).state).toBe('unpaid');
    const afterDep = (await call('PATCH', `/api/payments/${dep.id}`, a, { paid_on: '2026-11-01', method: 'Venmo' })).json();
    expect(afterDep.state).toBe('part_paid');
    expect(afterDep.received).toBe('300.00');
    expect(afterDep.outstanding).toBe('700.00');
    const afterBal = (await call('PATCH', `/api/payments/${bal.id}`, a, { paid_on: '2026-11-02' })).json();
    expect(afterBal.state).toBe('paid');
    expect(afterBal.received).toBe('1000.00');
    expect(afterBal.outstanding).toBe('0.00');
    const extra = (await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: '50.00', paid_on: '2026-11-03' })).json();
    expect(extra.state).toBe('overpaid');
    expect(extra.schedule_gap).toBe('-50.00');
  });
  it('writes who got paid into the gig notes', async () => {
    const id = await mkGig({ fee_quoted: 200 });
    const p = (await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'deposit', amount: '100', paid_on: '2026-11-01', method: 'check' })).json();
    await call('PATCH', `/api/payments/${p.payments[0].id}`, a, { paid_on: null });
    const log = (await call('GET', `/api/gigs/${id}`, a)).json();
    expect(log.gig).toBeTruthy();
    const rows = await withSystem(pool, (c) => c.query<{ body: string }>('SELECT body FROM activity WHERE gig_id = $1 ORDER BY created_at', [id]));
    const bodies = rows.rows.map((r) => r.body);
    expect(bodies.some((x) => x.includes('$100.00 received by check'))).toBe(true);
    expect(bodies.some((x) => x.includes('marked not paid'))).toBe(true);
  });
});

describe('payment rules', () => {
  it('only accepts dollars and cents above zero', async () => {
    const id = await mkGig();
    for (const amount of ['0', '-5', '12.345', 'abc', '', '1e3']) {
      expect((await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount })).statusCode).toBe(400);
    }
    expect((await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: 25 })).statusCode).toBe(201);
  });
  it('refuses a paid date well in the future', async () => {
    const id = await mkGig();
    const r = await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: '10', paid_on: '2099-01-01' });
    expect(r.json().error).toBe('paid_in_future');
  });
  it('locks a received payment from deletion, but allows an unpaid one', async () => {
    const id = await mkGig();
    const paid = (await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'deposit', amount: '10', paid_on: '2026-11-01' })).json().payments[0];
    const del = await call('DELETE', `/api/payments/${paid.id}`, a);
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe('paid_locked');
    await call('PATCH', `/api/payments/${paid.id}`, a, { paid_on: null });
    expect((await call('DELETE', `/api/payments/${paid.id}`, a)).statusCode).toBe(200);
  });
  it('shows a gap when payments do not match the fee', async () => {
    const id = await mkGig({ fee_quoted: 500 });
    const m = (await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'deposit', amount: '100' })).json();
    expect(m.schedule_gap).toBe('400.00');
  });
  it('blocks changes to an archived gig', async () => {
    const id = await mkGig();
    await call('PATCH', `/api/gigs/${id}`, a, { archived: true });
    const r = await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: '10' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('gig_archived');
  });
});

describe('who can do what', () => {
  it('read-only people can see money but not change it', async () => {
    const id = await mkGig();
    expect((await call('GET', `/api/gigs/${id}/money`, viewer)).statusCode).toBe(200);
    expect((await call('POST', `/api/gigs/${id}/payments`, viewer, { kind: 'other', amount: '10' })).statusCode).toBe(403);
    expect((await call('POST', `/api/gigs/${id}/payments/plan`, viewer, {})).statusCode).toBe(403);
  });
  it('another band cannot see or change this band\'s payments', async () => {
    const id = await mkGig();
    const p = (await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: '10' })).json().payments[0];
    expect((await call('GET', `/api/gigs/${id}/money`, b)).statusCode).toBe(404);
    expect((await call('POST', `/api/gigs/${id}/payments`, b, { kind: 'other', amount: '10' })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/payments/${p.id}`, b, { amount: '99' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/payments/${p.id}`, b)).statusCode).toBe(404);
  });
});

describe('lists', () => {
  it('gig list carries the payment state', async () => {
    const id = await mkGig({ fee_quoted: 100 });
    await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'deposit', amount: '40', paid_on: '2026-11-01' });
    const list = (await call('GET', '/api/gigs', a)).json();
    const row = (list.gigs ?? list).find((g: { id: string }) => g.id === id);
    expect(row.pay_state).toBe('part_paid');
    expect(row.received).toBe('40.00');
  });
  it('follow-ups list unpaid payments with a due date, and played gigs still owing', async () => {
    const due = await mkGig({ title: 'Due gig', fee_quoted: 100 });
    await call('POST', `/api/gigs/${due}/payments`, a, { kind: 'balance', amount: '100', due_on: '2026-11-20' });
    const owed = await mkGig({ title: 'Owed gig', stage: 'played', fee_quoted: 250 });
    const f = (await call('GET', '/api/followups', a)).json();
    expect(f.payments.some((p: { gig_id: string; amount: string }) => p.gig_id === due && p.amount === '100.00')).toBe(true);
    const o = f.owed.find((g: { id: string }) => g.id === owed);
    expect(o.outstanding).toBe('250.00');
    expect(f.owed.some((g: { id: string }) => g.id === due)).toBe(false);
  });
});

describe('testimonial reminder', () => {
  const tasks = (id: string) =>
    withSystem(pool, async (c) => (await c.query<{ body: string }>("SELECT body FROM activity WHERE gig_id = $1 AND kind = 'task'", [id])).rows);
  it('adds one task when a gig is marked Played, however many times the stage flips', async () => {
    const id = await mkGig();
    await call('PATCH', `/api/gigs/${id}`, a, { stage: 'played' });
    await call('PATCH', `/api/gigs/${id}`, a, { stage: 'confirmed' });
    await call('PATCH', `/api/gigs/${id}`, a, { stage: 'played' });
    const t = await tasks(id);
    expect(t.filter((x) => x.body === 'Ask Sam Smith for a testimonial')).toHaveLength(1);
  });
  it('adds nothing for a gig with no contact', async () => {
    const id = await mkGig({ contact_id: null });
    await call('PATCH', `/api/gigs/${id}`, a, { stage: 'played' });
    expect(await tasks(id)).toHaveLength(0);
  });
});

describe('order', () => {
  it('lists deposit before balance before other', async () => {
    const id = await mkGig({ fee_quoted: 100 });
    await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'other', amount: '5', paid_on: '2026-11-01' });
    await call('POST', `/api/gigs/${id}/payments/plan`, a, {}).catch(() => null);
    await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'balance', amount: '10', paid_on: '2026-11-02' });
    await call('POST', `/api/gigs/${id}/payments`, a, { kind: 'deposit', amount: '10', paid_on: '2026-11-03' });
    const kinds = (await money(id)).payments.map((p: { kind: string }) => p.kind);
    expect(kinds).toEqual(['deposit', 'balance', 'other']);
  });
});
