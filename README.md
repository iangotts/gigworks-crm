# GW-CRM

A custom multi-tenant CRM for the bands. One tenant per band: Jane Blonde and the Goldfingers, and ROCKSOLID. It is standalone. The old Bubble app (GW-GIG) keeps songs, setlists and the website. Gigs and contacts live only here.

The full plan, decisions and import rules are in the "GW-CRM: Gap Review and Build Plan" doc.

## Status

Phase 1 is done: the tenant-aware Postgres schema, with row-level security and tests. Phase 2 is done: the Node and TypeScript backend with login, sessions and tenant switching. The screens come next (phase 3).

## Backend

Node 20 or later, TypeScript, Fastify, `pg`, `zod`. Copy `.env.example` to `.env` and set `DATABASE_URL`.

```
npm install
npm run db:migrate && npm run db:seed
GWCRM_PASSWORD='at least 12 characters' npm run create-user -- --email you@example.com \
    --name "You" --membership janeblonde:admin --membership rocksolid:admin
npm run dev            # http://localhost:3000
npm test               # API tests, need DATABASE_URL
npm run typecheck
```

| Endpoint | What it does |
|---|---|
| `POST /api/login` | Email and password. Sets an HttpOnly, SameSite=Lax session cookie. Goes straight into the band if the user has only one. Limited to 10 tries a minute per address. |
| `POST /api/logout` | Ends the session. |
| `GET /api/me` | The user, their bands and roles, and the band they are working in. |
| `POST /api/session/tenant` | Choose which band to work in. Refused unless the user is a member. |
| `GET /api/contacts`, `POST /api/contacts` | Tenant-scoped list (with search) and create. The first working example of the pattern every later endpoint follows. |

How a request is handled:
- The session cookie is looked up in the `session` table, which stores only a hash of the token.
- The user's role in the chosen band is read from the database on every request, so removing a member or changing a role takes effect on their next request.
- Tenant data is only touched through `withTenant`, which runs `SET LOCAL ROLE crm_app` and sets the tenant and role for that transaction. The tenant always comes from the session, never from the request body.
- Changing requests from a browser with an unknown `Origin` header are refused.
- Wrong password, unknown email and disabled user all return the same answer in the same time.

Not done yet: password reset by email, inviting users from the screen (use `create-user` for now), and a per-account login lockout.

## Subscribe and unsubscribe (phase 5)

- Public pages, no login: `/subscribe/<band slug>` and `/unsubscribe/<token>`. The unsubscribe link is signed per contact and never expires. The export puts one in every row.
- Set `FORM_SECRET` (required in production, keep it stable or old unsubscribe links stop working) and `PUBLIC_URL` (the address people see). The public address must also be in `ALLOWED_ORIGINS`.
- Sign-up is single opt-in with a consent tickbox, a hidden trap field, a minimum fill time and rate limits. A form never re-subscribes someone who unsubscribed, bounced or is suppressed.
- Export: Contacts, then Email list, then Download CSV. Admins and members only. Only people with a `subscribed` record are included.

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
db/tests/        tenant isolation tests (SQL)
scripts/db.sh    migrate, seed, test, status
src/             the API: app.ts, auth.ts, db.ts, sessions.ts, routes/, cli/
test/            API tests (vitest)
```

Bubble CSV exports contain personal data. They are ignored by git and must stay out of the repo.

## Web app (phase 3)

The screens live in `web/` (React, Vite, TypeScript): the gig pipeline, contacts with an activity log (call, voicemail, text, email, note, to-do), follow-ups and replies owed, templates, and links (a builder that tags a website address with UTM parameters for one contact or gig; no contact identifier goes in the address). The page is chosen by the address, for example `#/contacts`. Venues have no screen yet; they can still be picked and added from a gig.

```bash
# one terminal: the API on :3000
npm run dev
# another terminal: the web app on :5173, which proxies /api to :3000
cd web && npm install && npm run dev
```

For production, run `cd web && npm run build`, then start the API. It serves `web/dist` and falls back to `index.html` for every page that is not under `/api`.

Checks: `npm test` (backend, needs `DATABASE_URL`) and `cd web && npm test` (screen logic).
