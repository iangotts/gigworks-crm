import pg from 'pg';

// Dates (no time) stay as 'YYYY-MM-DD' text. Turning them into JS Dates would shift them by
// the server's time zone and show a gig on the wrong day.
pg.types.setTypeParser(1082, (v) => v);

export type Role = 'admin' | 'member' | 'read_only';

export interface TenantContext {
  userId: string;
  tenantId: string;
  role: Role;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

async function run<T>(
  pool: pg.Pool,
  setup: (c: pg.PoolClient) => Promise<void>,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setup(c);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await c.query('ROLLBACK');
    } catch {
      // the connection is already broken, the original error matters more
    }
    throw err;
  } finally {
    c.release();
  }
}

// Switch to the app role and set the values the row-level security policies read.
// set_config(..., true) lasts for this transaction only, so nothing leaks to the next request.
async function enter(c: pg.PoolClient, userId: string, tenantIds: string[], role: string): Promise<void> {
  await c.query('SET LOCAL ROLE crm_app');
  await c.query(
    `SELECT set_config('app.user_id', $1, true),
            set_config('app.tenant_ids', $2, true),
            set_config('app.role', $3, true)`,
    [userId, tenantIds.join(','), role],
  );
}

/** No user and no tenant. Only for login, which uses the auth_lookup function. */
export function withAnonymous<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return run(pool, (c) => enter(c, '', [], ''), fn);
}

/** A known user, no tenant chosen yet. They can see their own memberships and tenants. */
export function withUser<T>(pool: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return run(pool, (c) => enter(c, userId, [], ''), fn);
}

/** Working inside one tenant. The tenant and role must come from a membership the backend checked. */
export function withTenant<T>(pool: pg.Pool, ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return run(pool, (c) => enter(c, ctx.userId, [ctx.tenantId], ctx.role), fn);
}

/** The owner login, outside row-level security. Only for sessions and admin tooling. Never for tenant data. */
export function withSystem<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return run(pool, async () => {}, fn);
}
