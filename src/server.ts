import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { purgeExpiredSessions } from './sessions.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp(config, pool, { logger: true });

const timer = setInterval(() => {
  purgeExpiredSessions(pool).catch((err) => app.log.error(err));
}, 60 * 60 * 1000);
timer.unref();

const stop = async (): Promise<void> => {
  clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await app.listen({ port: config.port, host: '0.0.0.0' });
