import { createHash, randomBytes } from 'node:crypto';
import { withSystem } from './db.js';
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
/** Returns the cookie token. Only its hash is stored. */
export async function createSession(pool, userId, tenantId, days) {
    const token = randomBytes(32).toString('base64url');
    await withSystem(pool, (c) => c.query(`INSERT INTO session (id, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`, [hashToken(token), userId, tenantId, days]));
    return token;
}
/** A valid session for an active user, or null. Also pushes the expiry out, at most once an hour. */
export async function getSession(pool, token, days) {
    const id = hashToken(token);
    return withSystem(pool, async (c) => {
        const { rows } = await c.query(`SELECT s.id, s.user_id, s.tenant_id
         FROM session s JOIN app_user u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`, [id]);
        const row = rows[0];
        if (!row)
            return null;
        await c.query(`UPDATE session SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        WHERE id = $1 AND last_seen_at < now() - interval '1 hour'`, [id, days]);
        return { id: row.id, userId: row.user_id, tenantId: row.tenant_id };
    });
}
export async function setSessionTenant(pool, sessionId, tenantId) {
    await withSystem(pool, (c) => c.query('UPDATE session SET tenant_id = $2 WHERE id = $1', [sessionId, tenantId]));
}
export async function deleteSession(pool, sessionId) {
    await withSystem(pool, (c) => c.query('DELETE FROM session WHERE id = $1', [sessionId]));
}
export async function purgeExpiredSessions(pool) {
    const res = await withSystem(pool, (c) => c.query('DELETE FROM session WHERE expires_at <= now()'));
    return res.rowCount ?? 0;
}
