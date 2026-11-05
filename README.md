# GW-CRM

A custom multi-tenant CRM for the bands. One tenant per band: Jane Blonde and the Goldfingers, and ROCKSOLID. It is standalone. The old Bubble app (GW-GIG) keeps songs, setlists and the website. Gigs and contacts live only here.

The full plan, decisions and import rules are in the "GW-CRM: Gap Review and Build Plan" doc.

## Status

Phase 1 is done: the tenant-aware Postgres schema, with row-level security and tests. The backend, login and screens come next (phases 2 and 3).

## Database

Postgres 15 or later (the schema uses `ON DELETE SET NULL (column)`). Needs `psql` and a `DATABASE_URL` for a login that owns the database. On Railway the default login is a superuser, which is what the import and the tests need.

```
export DATABASE_URL=postgres://user:pass@host:5432/gigworks_crm
scripts/db.sh migrate    # apply migrations in db/migrations
scripts/db.sh seed       # the two tenants and the import rules
scripts/db.sh test       # tenant isolation tests (roll back, leave nothing behind)
```

### Tables

| Area | Tables |
|---|---|
| Identity | `app_user` (logins), `tenant` (one per band), `membership` (user in tenant, role admin / member / read_only) |
| People | `contact` (the prospects), `contact_role` (role on a gig or at a venue, or band-member status), `subscription` (marketing consent), `venue` (reference list) |
| Gigs | `gig` (with the lead block), `gig_member` (who plays, confirmed or not), `payment` (deposit and balance only) |
| Activity | `activity` (call, voicemail, text, email, note, task) |
| Links and email | `link_target`, `outbound_link` (UTM), `link_click`, `template` |
| Import | `import_mapping` (band to tenant, status to stage), `import_id_map` (old id to new id) |

Gig stages: new, evaluating, in_conversation, confirmed, played, lost. `postponed` is a flag on confirmed.

### How tenant isolation works

Every tenant table has a `tenant_id` and a row-level security policy. Foreign keys are composite `(tenant_id, id)`, so a gig cannot point at another band's venue or contact even by mistake.

The app must run each request in a transaction like this:

```sql
BEGIN;
SET LOCAL ROLE crm_app;
SELECT set_config('app.user_id',    '<user uuid>',             true);
SELECT set_config('app.tenant_ids', '<tenant uuid>',           true);  -- one id normally
SELECT set_config('app.role',       'admin|member|read_only',  true);  -- from membership
-- queries here
COMMIT;
```

Rules:
- `SET LOCAL ROLE crm_app` is required. Superusers and table owners with BYPASSRLS skip row-level security.
- The backend must check the user's membership before it sets `app.tenant_ids` and `app.role`. The database trusts those values once they are set.
- With no tenant set, queries return nothing. They never return everything.
- `read_only` can read but not write. Only `admin` can change memberships.
- Two ids in `app.tenant_ids` give the combined view for people who are admin in both bands (a later phase).
- Login runs before a tenant is chosen. Use `SELECT * FROM auth_lookup(email)`, which returns one user row and nothing else. After the password check, set `app.user_id` and read that user's memberships.
- The app role has no access to `import_mapping` or `import_id_map`, and cannot read `password_hash`.

## Layout

```
db/migrations/   numbered SQL, applied in order and recorded in schema_migrations
db/seeds/        tenants and import rules
db/tests/        tenant isolation tests
scripts/db.sh    migrate, seed, test, status
```

Bubble CSV exports contain personal data. They are ignored by git and must stay out of the repo.
