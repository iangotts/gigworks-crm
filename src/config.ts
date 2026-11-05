export interface Config {
  databaseUrl: string;
  port: number;
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionDays: number;
  scryptLogN: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined || v === '' ? d : Number(v);
    if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
    return n;
  };
  return {
    databaseUrl,
    port: num(env.PORT, 3000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieSecure: (env.COOKIE_SECURE ?? String(env.NODE_ENV === 'production')) === 'true',
    sessionDays: num(env.SESSION_DAYS, 14),
    scryptLogN: num(env.SCRYPT_LOG_N, 16),
  };
}
