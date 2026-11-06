// One-to-one email: sender settings, sending, the saved activity, duplicate and safety rules. Same setup as api.test.ts: real Postgres, own tenants and users, cleaned up after.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, withSystem } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { logProvider, sendGridProvider } from '../src/email.js';

const PASSWORD = 'correct horse battery staple';
const tag = randomBytes(4).toString('hex');
const config: Config = { ...loadConfig({ ...process.env, SCRYPT_LOG_N: '10' }), allowedOrigins: ['http://app.test'] };
const pool = createPool(config.databaseUrl);

let app: FastifyInstance;
const ids: Record<string, string> = {};
const email = (n: string): string => `itest-${tag}-e${n}@example.test`;

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

const provider = logProvider();
let a: Record<string, string>; // admin in tenant A
let m: Record<string, string>; // member in tenant A
let viewer: Record<string, string>;
let b: Record<string, string>; // admin in tenant B

const SETTINGS = { from_name: 'Jane Blonde', from_email: 'bookings@example.test', reply_to: 'ian@example.test', signature: 'Ian\nJane Blonde and the Goldfingers' };
const send = (h: Record<string, string>, over: object = {}) =>
  call('POST', '/api/email/send', h, { contact_id: ids.priya, subject: 'Your wedding', body: 'Hi Priya, thanks for getting in touch.', request_id: crypto.randomUUID(), ...over });
const emails = async (contact: string | undefined) => (await call('GET', `/api/activity?contact_id=${contact}`, a)).json().activity.filter((x: { kind: string }) => x.kind === 'email');

beforeAll(async () => {
  app = await buildApp(config, pool, { loginLimit: 1000, emailProvider: provider });
  await withSystem(pool, async (c) => {
    for (const k of ['A', 'B']) {
      const t = await c.query<{ id: string }>('INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id', [`Email Test ${k}`, `itest-e${k.toLowerCase()}-${tag}`]);
      ids[k] = (t.rows[0] as { id: string }).id;
    }
    const mk = async (tenant: string, first: string, em: string | null): Promise<string> =>
      ((await c.query<{ id: string }>('INSERT INTO contact (tenant_id, first_name, email) VALUES ($1, $2, $3) RETURNING id', [ids[tenant], first, em])).rows[0] as { id: string }).id;
    ids.priya = await mk('A', 'Priya', `priya-${tag}@example.test`);
    ids.noemail = await mk('A', 'Nomail', null);
    ids.unsub = await mk('A', 'Una', `una-${tag}@example.test`);
    ids.bounced = await mk('A', 'Bo', `bo-${tag}@example.test`);
    ids.contactB = await mk('B', 'Bee', `bee-${tag}@example.test`);
    for (const [cid, st] of [[ids.unsub, 'unsubscribed'], [ids.bounced, 'bounced']] as const) {
      await c.query("INSERT INTO subscription (tenant_id, contact_id, status, consent_source) VALUES ($1, $2, $3, 'test')", [ids.A, cid, st]);
    }
    const g = await c.query<{ id: string }>("INSERT INTO gig (tenant_id, title, stage, contact_id) VALUES ($1, 'Smith wedding', 'in_conversation', $2) RETURNING id", [ids.A, ids.priya]);
    ids.gig = (g.rows[0] as { id: string }).id;
  });
  await makeUser('a', 'A', 'admin');
  await makeUser('m', 'A', 'member');
  await makeUser('viewer', 'A', 'read_only');
  await makeUser('b', 'B', 'admin');
  [a, m, viewer, b] = await Promise.all([login('a'), login('m'), login('viewer'), login('b')]);
});

afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-e%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-e%-${tag}`]);
  });
  await app.close();
  await pool.end();
});

describe('sender settings', () => {
  it('sending is refused until the band has set who mail comes from', async () => {
    const r = await send(a);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('email_not_set_up');
    expect(provider.sent).toHaveLength(0);
  });
  it('only an admin can change them, and bad addresses are refused', async () => {
    expect((await call('PUT', '/api/email/settings', m, SETTINGS)).statusCode).toBe(403);
    expect((await call('PUT', '/api/email/settings', viewer, SETTINGS)).statusCode).toBe(403);
    expect((await call('PUT', '/api/email/settings', a, { ...SETTINGS, from_email: 'not an address' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/email/settings', a, { ...SETTINGS, from_name: 'Evil\r\nBcc: x@y.z' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/email/settings', a, SETTINGS)).statusCode).toBe(200);
  });
  it('every member can read them, and another band cannot', async () => {
    const mine = (await call('GET', '/api/email/settings', viewer)).json();
    expect(mine.settings.reply_to).toBe('ian@example.test');
    expect(mine.can_send).toBe(true);
    const theirs = (await call('GET', '/api/email/settings', b)).json();
    expect(theirs.settings).toBeNull();
    expect(theirs.can_send).toBe(false);
  });
  it('a test email goes only to the person who asked', async () => {
    provider.sent.length = 0;
    const r = await call('POST', '/api/email/test', m, {});
    expect(r.statusCode).toBe(200);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe(email('m'));
    expect(provider.sent[0]?.replyTo).toBe('ian@example.test');
    expect((await call('POST', '/api/email/test', viewer, {})).statusCode).toBe(403);
  });
});

describe('sending one email', () => {
  it('sends from the band address, replies to the band mailbox, and saves it in the activity', async () => {
    provider.sent.length = 0;
    const r = await send(a, { gig_id: ids.gig });
    expect(r.statusCode).toBe(201);
    const row = r.json();
    expect(row.delivery).toBe('sent');
    expect(row.subject).toBe('Your wedding');
    expect(row.email_to).toBe(`priya-${tag}@example.test`);
    expect(provider.sent).toHaveLength(1);
    const mail = provider.sent[0]!;
    expect(mail).toMatchObject({ fromEmail: 'bookings@example.test', fromName: 'Jane Blonde', replyTo: 'ian@example.test', to: `priya-${tag}@example.test` });
    expect(mail.text).toContain('thanks for getting in touch');
    expect(mail.text).toContain('Jane Blonde and the Goldfingers'); // signature
    const log = await emails(ids.priya);
    expect(log.some((x: { id: string }) => x.id === row.id)).toBe(true);
    const onGig = (await call('GET', `/api/activity?gig_id=${ids.gig}`, a)).json().activity;
    expect(onGig.some((x: { id: string }) => x.id === row.id)).toBe(true);
    const stored = await withSystem(pool, (c) => c.query('SELECT provider_message_id, body FROM activity WHERE id = $1', [row.id]));
    expect(stored.rows[0].provider_message_id).toMatch(/^log-/);
    expect(stored.rows[0].body).toBe(mail.text); // the log holds exactly what went out
  });
  it('a member can send, a read-only member cannot', async () => {
    expect((await send(m)).statusCode).toBe(201);
    const r = await send(viewer);
    expect(r.statusCode).toBe(403);
  });
  it('the same request never sends twice, even two at once', async () => {
    provider.sent.length = 0;
    const request_id = crypto.randomUUID();
    const [x, y] = await Promise.all([send(a, { request_id }), send(a, { request_id })]);
    expect(provider.sent).toHaveLength(1);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 201]);
    const again = await send(a, { request_id });
    expect(again.json().duplicate).toBe(true);
    expect(provider.sent).toHaveLength(1);
  });
  it('a pasted line break cannot add a header', async () => {
    provider.sent.length = 0;
    await send(a, { subject: 'Hello\r\nBcc: spy@example.test' });
    expect(provider.sent[0]?.subject).toBe('Hello Bcc: spy@example.test');
  });
  it('refuses a message with an unfilled merge field', async () => {
    provider.sent.length = 0;
    for (const over of [{ body: 'Hi {first_name}, thanks' }, { subject: 'About {gig}' }]) {
      const r = await send(a, over);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('unfilled_placeholder');
    }
    expect(provider.sent).toHaveLength(0);
  });
  it('refuses a contact with no email, a bounced address and another band\'s contact', async () => {
    provider.sent.length = 0;
    expect((await send(a, { contact_id: ids.noemail })).json().error).toBe('no_email');
    expect((await send(a, { contact_id: ids.bounced })).json().error).toBe('address_blocked');
    expect((await send(a, { contact_id: ids.contactB })).statusCode).toBe(404);
    expect((await send(a, { gig_id: crypto.randomUUID() })).statusCode).toBe(404);
    expect(provider.sent).toHaveLength(0);
  });
  it('an unsubscribed person is only emailed after an explicit confirm', async () => {
    provider.sent.length = 0;
    const r = await send(a, { contact_id: ids.unsub });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('unsubscribed');
    expect(provider.sent).toHaveLength(0);
    expect((await send(a, { contact_id: ids.unsub, confirm_unsubscribed: true })).statusCode).toBe(201);
  });
  it('a failed send is recorded as failed and can be retried', async () => {
    provider.sent.length = 0;
    provider.failNext = 'The email service rejected the message (400). Bad sender.';
    const r = await send(a, { subject: 'Will fail' });
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toContain('Bad sender');
    const failed = (await emails(ids.priya)).find((x: { subject: string }) => x.subject === 'Will fail');
    expect(failed.delivery).toBe('failed');
    expect(failed.delivery_error).toContain('Bad sender');
    expect((await send(a, { subject: 'Will fail' })).statusCode).toBe(201);
  });
  it('the saved copy of a sent email cannot be edited, but notes still can', async () => {
    const sent = (await emails(ids.priya))[0];
    const r = await call('PATCH', `/api/activity/${sent.id}`, a, { body: 'rewritten' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('sent_email_locked');
    const note = (await call('POST', '/api/activity', a, { kind: 'note', contact_id: ids.priya, body: 'x' })).json();
    expect((await call('PATCH', `/api/activity/${note.id}`, a, { body: 'y' })).statusCode).toBe(200);
  });
  it('a manual email log entry is still allowed', async () => {
    const r = await call('POST', '/api/activity', a, { kind: 'email', contact_id: ids.priya, body: 'Replied from my phone' });
    expect(r.statusCode).toBe(201);
    expect(r.json().delivery).toBeNull();
  });
  it('stops a runaway at the daily cap', async () => {
    const capped = await buildApp({ ...config, emailDailyCap: 1 }, pool, { loginLimit: 1000, emailProvider: provider });
    const login2 = await capped.inject({ method: 'POST', url: '/api/login', payload: { email: email('b'), password: PASSWORD } });
    const ck = login2.cookies.find((c) => c.name === 'gwcrm_session');
    const hb = { cookie: `gwcrm_session=${ck?.value}` };
    await call('PUT', '/api/email/settings', b, SETTINGS);
    const go = () => capped.inject({ method: 'POST', url: '/api/email/send', headers: hb, payload: { contact_id: ids.contactB, subject: 'Hi', body: 'Hello', request_id: crypto.randomUUID() } });
    expect((await go()).statusCode).toBe(201);
    const second = await go();
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe('daily_limit');
    await capped.close();
  });
  it('refuses when no provider is configured', async () => {
    const none = await buildApp({ ...config, emailProvider: 'none' }, pool, { loginLimit: 1000 });
    const r = await none.inject({ method: 'POST', url: '/api/email/send', headers: a, payload: { contact_id: ids.priya, subject: 'Hi', body: 'Hello', request_id: crypto.randomUUID() } });
    expect(r.statusCode).toBe(503);
    await none.close();
  });
});

describe('SendGrid adapter', () => {
  const mail = { fromName: 'Jane', fromEmail: 'a@example.test', replyTo: 'r@example.test', to: 'x@example.test', subject: 'Hi', text: 'Line one\n\nA <b> & more' };
  it('sends the right request with tracking off and returns the message id', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 202, headers: { 'x-message-id': 'abc123' } });
    }) as unknown as typeof fetch;
    const r = await sendGridProvider('KEY', fake).send(mail);
    expect(r.id).toBe('abc123');
    const body = JSON.parse(String((seen as unknown as { init: RequestInit }).init.body));
    expect(body.reply_to.email).toBe('r@example.test');
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
    expect(body.tracking_settings.open_tracking.enable).toBe(false);
    expect(body.content[1].value).toBe('<p>Line one</p><p>A &lt;b&gt; &amp; more</p>');
    expect(((seen as unknown as { init: RequestInit }).init.headers as Record<string, string>).authorization).toBe('Bearer KEY');
  });
  it('turns provider and network failures into plain errors without leaking the key', async () => {
    const refuse = (async () => new Response(JSON.stringify({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }), { status: 403 })) as unknown as typeof fetch;
    await expect(sendGridProvider('SECRET', refuse).send(mail)).rejects.toThrow(/verified Sender Identity/);
    const down = (async () => { throw new Error('connect ECONNREFUSED with SECRET'); }) as unknown as typeof fetch;
    const err = await sendGridProvider('SECRET', down).send(mail).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('SECRET');
  });
});
