import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../auth.js';
import { withAnonymous } from '../db.js';
import { checkFormToken, formToken, readUnsubToken } from '../tokens.js';

/** What the person agrees to. {band} is the band's name. This exact wording is shown and recorded. */
export const consentText = (band: string): string =>
  `Yes, email me news and gig announcements from ${band}. I can unsubscribe at any time.`;

const subscribeBody = z.object({
  email: z.string().trim().min(3).max(320),
  first_name: z.string().trim().max(200).optional(),
  last_name: z.string().trim().max(200).optional(),
  consent: z.boolean(),
  token: z.string().max(200),
  // A real person never sees this field. A script that fills in every field does.
  website: z.string().max(500).optional(),
});
const slugParam = z.object({ slug: z.string().trim().min(1).max(100) });
const tokenParam = z.object({ token: z.string().max(200) });

const mask = (email: string | null): string => {
  if (!email) return '';
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
};

export interface PublicLimits {
  /** Subscribe attempts per minute per address. */
  subscribe: number;
  /** Other public requests per minute per address. */
  other: number;
}

export function registerPublicRoutes(app: FastifyInstance, deps: Deps, limits: PublicLimits): void {
  const { config, pool } = deps;
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  const contactFromToken = (token: string): string | null => readUnsubToken(config.formSecret, token);

  // The subscribe form asks for the band's name, the wording to show, and a token proving when it was opened.
  app.get('/api/public/band/:slug', limit(limits.other), async (req, reply) => {
    const { slug } = slugParam.parse(req.params);
    const row = await withAnonymous(pool, async (c) =>
      (await c.query<{ name: string }>('SELECT name FROM public_tenant($1)', [slug])).rows[0],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { name: row.name, consent_text: consentText(row.name), token: formToken(config.formSecret, slug.toLowerCase()) };
  });

  // Always answers the same way, so the form cannot be used to find out who is on the list.
  app.post('/api/public/band/:slug/subscribe', limit(limits.subscribe), async (req, reply) => {
    const { slug } = slugParam.parse(req.params);
    const b = subscribeBody.parse(req.body);
    const quiet = (): unknown => reply.code(202).send({ ok: true });
    if (b.website && b.website.trim() !== '') return quiet(); // filled-in trap field: drop it
    const check = checkFormToken(config.formSecret, slug.toLowerCase(), b.token);
    if (check === 'too_fast') return quiet();
    if (check !== 'ok') return reply.code(400).send({ error: 'form_expired' });
    if (!b.consent) return reply.code(400).send({ error: 'consent_required' });
    await withAnonymous(pool, async (c) => {
      const band = (await c.query<{ name: string }>('SELECT name FROM public_tenant($1)', [slug])).rows[0];
      if (!band) return;
      await c.query('SELECT public_subscribe($1, $2, $3, $4, $5)', [slug, b.email, b.first_name ?? null, b.last_name ?? null, consentText(band.name)]);
    });
    return quiet();
  });

  // The unsubscribe page. A link in an email is opened by mail scanners too, so a visit changes nothing:
  // the person presses the button, which posts.
  app.get('/api/public/unsubscribe/:token', limit(limits.other), async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    const id = contactFromToken(token);
    const row = id ? await withAnonymous(pool, async (c) => (await c.query<{ band: string; email: string | null; status: string }>('SELECT * FROM public_contact_info($1)', [id])).rows[0]) : undefined;
    if (!row) return reply.code(404).send({ error: 'invalid_link' });
    return { band: row.band, email: mask(row.email), status: row.status };
  });

  const setStatus = (status: 'unsubscribed' | 'subscribed') => async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = tokenParam.parse(req.params);
    const id = contactFromToken(token);
    const result = id ? await withAnonymous(pool, async (c) => (await c.query<{ s: string | null }>('SELECT public_set_subscription($1, $2) AS s', [id, status])).rows[0]?.s) : null;
    if (!result) return reply.code(404).send({ error: 'invalid_link' });
    return { status: result };
  };
  // Mail programs can also post here directly (one-click unsubscribe).
  app.post('/api/public/unsubscribe/:token', limit(limits.other), setStatus('unsubscribed'));
  app.post('/api/public/resubscribe/:token', limit(limits.other), setStatus('subscribed'));
}
