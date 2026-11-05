// Create or update a login and give it memberships. Runs as the database owner.
//
//   GWCRM_PASSWORD='...' npm run create-user -- --email ian@example.com --name "Ian" \
//       --membership janeblonde:admin --membership rocksolid:admin
//
// The password comes from the GWCRM_PASSWORD environment variable, not a flag, so it stays out
// of shell history. Running it again for the same email resets the password and updates roles.
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, withSystem } from '../db.js';
import { hashPassword } from '../passwords.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    membership: { type: 'string', multiple: true },
  },
});

const email = values.email?.trim().toLowerCase();
const password = process.env.GWCRM_PASSWORD;
if (!email || !password) {
  console.error('Need --email and the GWCRM_PASSWORD environment variable.');
  process.exit(2);
}
if (password.length < 12) {
  console.error('Use a password of at least 12 characters.');
  process.exit(2);
}

const memberships = (values.membership ?? []).map((m) => {
  const [slug, role] = m.split(':');
  if (!slug || !role || !['admin', 'member', 'read_only'].includes(role)) {
    console.error(`Bad --membership "${m}". Use slug:role, with role admin, member or read_only.`);
    process.exit(2);
  }
  return { slug, role };
});

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const hash = await hashPassword(password, config.scryptLogN);
  await withSystem(pool, async (c) => {
    const user = await c.query<{ id: string }>(
      `INSERT INTO app_user (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             name = COALESCE(EXCLUDED.name, app_user.name),
             is_active = true
       RETURNING id`,
      [email, values.name ?? null, hash],
    );
    const userId = (user.rows[0] as { id: string }).id;
    for (const m of memberships) {
      const res = await c.query(
        `INSERT INTO membership (tenant_id, user_id, role)
         SELECT id, $2, $3 FROM tenant WHERE slug = $1
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [m.slug, userId, m.role],
      );
      if (res.rowCount === 0) throw new Error(`No tenant with slug "${m.slug}". Run npm run db:seed first.`);
    }
  });
  console.log(`Saved ${email} with ${memberships.length} membership(s).`);
} finally {
  await pool.end();
}
