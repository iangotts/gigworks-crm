-- 0001_foundation: app role and the helper functions that row-level security uses.
--
-- How tenancy works (see README):
--   The app connects with a normal login, then for each request/transaction runs
--     SET LOCAL ROLE crm_app;
--     SELECT set_config('app.user_id',    '<user uuid>',            true);
--     SELECT set_config('app.tenant_ids', '<tenant uuid>[,<uuid>]', true);
--     SELECT set_config('app.role',       'admin|member|read_only', true);
--   Every tenant table has a policy that only shows rows whose tenant_id is in app.tenant_ids.
--   One tenant id is the normal case. Two ids is the later combined view for people who are
--   admin in both bands. The backend must check membership before it sets these values.
--   Superusers bypass RLS, which is why the app must SET ROLE crm_app.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
END $$;

-- Lets the owner login SET ROLE crm_app (a superuser can already, this covers the rest).
GRANT crm_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO crm_app;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Tenants the current request may see. Empty setting means none, never all.
CREATE FUNCTION visible_tenants() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN coalesce(current_setting('app.tenant_ids', true), '') = '' THEN ARRAY[]::uuid[]
           ELSE string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[]
         END
$$;

CREATE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- admin and member may write. read_only and anything unset may not.
CREATE FUNCTION writes_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.role', true), '') IN ('admin', 'member')
$$;

CREATE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.role', true), '') = 'admin'
$$;
