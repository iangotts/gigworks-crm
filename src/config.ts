import { randomBytes } from 'node:crypto';

export interface Config {
  databaseUrl: string;
  port: number;
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionDays: number;
  scryptLogN: number;
  /** Signs the subscribe form and the unsubscribe links. Keep it the same across restarts. */
  formSecret: string;
  /** The address people see in links, with no trailing slash. */
  publicUrl: string;
  /** 'sendgrid' sends for real, 'log' keeps mail in memory (local work), 'none' refuses. */
  emailProvider: 'sendgrid' | 'log' | 'none';
  sendgridKey: string;
  /** Most one-to-one emails a band can send in 24 hours. A runaway guard, not a quota. */
  emailDailyCap: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined || v === '' ? d : Number(v);
    if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
    return n;
  };
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let formSecret = env.FORM_SECRET ?? '';
  if (!formSecret) {
    if (env.NODE_ENV === 'production') throw new Error('FORM_SECRET is required in production. Unsubscribe links would stop working at every restart without it.');
    formSecret = randomBytes(32).toString('hex'); // fine for local work and tests
  }
  const sendgridKey = env.SENDGRID_API_KEY ?? '';
  const asked = env.EMAIL_PROVIDER;
  if (asked && !['sendgrid', 'log', 'none'].includes(asked)) throw new Error('EMAIL_PROVIDER must be sendgrid, log or none');
  const emailProvider = (asked as Config['emailProvider'] | undefined) ?? (sendgridKey ? 'sendgrid' : env.NODE_ENV === 'production' ? 'none' : 'log');
  if (emailProvider === 'sendgrid' && !sendgridKey) throw new Error('SENDGRID_API_KEY is required when EMAIL_PROVIDER is sendgrid');
  return {
    databaseUrl,
    port: num(env.PORT, 3000),
    allowedOrigins,
    cookieSecure: (env.COOKIE_SECURE ?? String(env.NODE_ENV === 'production')) === 'true',
    sessionDays: num(env.SESSION_DAYS, 14),
    scryptLogN: num(env.SCRYPT_LOG_N, 16),
    formSecret,
    emailProvider,
    sendgridKey,
    emailDailyCap: num(env.EMAIL_DAILY_CAP, 200),
    publicUrl: (env.PUBLIC_URL ?? allowedOrigins[0] ?? 'http://localhost:5173').replace(/\/+$/, ''),
  };
}
