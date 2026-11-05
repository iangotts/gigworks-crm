import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerAuthRoutes } from './routes/auth.js';
import { registerContactRoutes } from './routes/contacts.js';
export async function buildApp(config, pool, opts = {}) {
    const app = Fastify({
        logger: opts.logger ?? false,
        trustProxy: true, // behind Railway's proxy, so rate limits see the real address
        bodyLimit: 1024 * 1024,
    });
    const deps = { pool, config };
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    // Changing requests from a browser carry an Origin header. If it is present and is not one
    // of ours, refuse. The session cookie is also SameSite=Lax, which blocks cross-site posts.
    app.addHook('onRequest', async (req, reply) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
            return;
        const origin = req.headers.origin;
        if (origin && !config.allowedOrigins.includes(origin)) {
            return reply.code(403).send({ error: 'bad_origin' });
        }
    });
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof ZodError) {
            return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
        }
        if (err.statusCode && err.statusCode < 500) {
            return reply.code(err.statusCode).send({ error: err.message });
        }
        req.log.error(err);
        return reply.code(500).send({ error: 'server_error' });
    });
    app.get('/api/health', async () => {
        await pool.query('SELECT 1');
        return { ok: true };
    });
    registerAuthRoutes(app, deps, opts.loginLimit ?? 10);
    registerContactRoutes(app, deps);
    return app;
}
