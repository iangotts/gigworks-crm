import pg from 'pg';
export function createPool(connectionString) {
    return new pg.Pool({ connectionString, max: 10 });
}
async function run(pool, setup, fn) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await setup(c);
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
    }
    catch (err) {
        try {
            await c.query('ROLLBACK');
        }
        catch {
            // the connection is already broken, the original error matters more
        }
        throw err;
    }
    finally {
        c.release();
    }
}
// Switch to the app role and set the values the row-level security policies read.
// set_config(..., true) lasts for this transaction only, so nothing leaks to the next request.
async function enter(c, userId, tenantIds, role) {
    await c.query('SET LOCAL ROLE crm_app');
    await c.query(`SELECT set_config('app.user_id', $1, true),
            set_config('app.tenant_ids', $2, true),
            set_config('app.role', $3, true)`, [userId, tenantIds.join(','), role]);
}
/** No user and no tenant. Only for login, which uses the auth_lookup function. */
export function withAnonymous(pool, fn) {
    return run(pool, (c) => enter(c, '', [], ''), fn);
}
/** A known user, no tenant chosen yet. They can see their own memberships and tenants. */
export function withUser(pool, userId, fn) {
    return run(pool, (c) => enter(c, userId, [], ''), fn);
}
/** Working inside one tenant. The tenant and role must come from a membership the backend checked. */
export function withTenant(pool, ctx, fn) {
    return run(pool, (c) => enter(c, ctx.userId, [ctx.tenantId], ctx.role), fn);
}
/** The owner login, outside row-level security. Only for sessions and admin tooling. Never for tenant data. */
export function withSystem(pool, fn) {
    return run(pool, async () => { }, fn);
}
