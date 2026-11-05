import { createHmac, timingSafeEqual } from 'node:crypto';

const sign = (secret: string, text: string): string => createHmac('sha256', secret).update(text).digest('base64url').slice(0, 32);

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A token the subscribe form carries back, so the server knows when the form was opened. */
export function formToken(secret: string, slug: string, now: number = Date.now()): string {
  const ts = String(now);
  return `${ts}.${sign(secret, `form:${slug}:${ts}`)}`;
}

export type FormCheck = 'ok' | 'too_fast' | 'expired' | 'invalid';

/** A real person takes more than a few seconds. A script that posts at once is dropped quietly. */
export function checkFormToken(secret: string, slug: string, token: string, now: number = Date.now(), minMs = 3000, maxMs = 2 * 60 * 60 * 1000): FormCheck {
  const [ts, mac] = token.split('.');
  if (!ts || !mac || !/^\d{10,15}$/.test(ts)) return 'invalid';
  if (!same(mac, sign(secret, `form:${slug}:${ts}`))) return 'invalid';
  const age = now - Number(ts);
  if (age < minMs) return 'too_fast';
  if (age > maxMs) return 'expired';
  return 'ok';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The unsubscribe link token for one contact. It does not expire: an old email must still work. */
export function unsubToken(secret: string, contactId: string): string {
  return `${contactId}.${sign(secret, `unsub:${contactId}`)}`;
}

/** The contact id inside a valid unsubscribe token, or null. */
export function readUnsubToken(secret: string, token: string): string | null {
  const [id, mac] = token.split('.');
  if (!id || !mac || !UUID.test(id)) return null;
  return same(mac, sign(secret, `unsub:${id}`)) ? id : null;
}
