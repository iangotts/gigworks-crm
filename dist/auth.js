import { withUser } from './db.js';
import { getSession, setSessionTenant } from './sessions.js';
export const COOKIE_NAME = 'gwcrm_session';
/**
 * Who is making this request. Returns null when there is no valid session.
 * The role is looked up every time, so removing a member or changing their role
 * takes effect on their very next request.
 */
export async function authenticate(deps, req) {
    const token = req.cookies[COOKIE_NAME];
    if (!token)
        return null;
    const session = await getSession(deps.pool, token, deps.config.sessionDays);
    if (!session)
        return null;
    let tenantId = session.tenantId;
    let role = null;
    if (tenantId) {
        const found = tenantId;
        const res = await withUser(deps.pool, session.userId, (c) => c.query('SELECT role FROM membership WHERE tenant_id = $1 AND user_id = $2', [
            found,
            session.userId,
        ]));
        role = res.rows[0]?.role ?? null;
        if (!role) {
            // They were removed from that tenant since they chose it.
            await setSessionTenant(deps.pool, session.id, null);
            tenantId = null;
        }
    }
    return { sessionId: session.id, userId: session.userId, tenantId, role };
}
