-- 0002_identity: logins, tenants (one per band) and memberships.
-- A user is a login. One user can belong to several tenants through membership rows.

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  name          text,
  password_hash text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_key ON app_user (email);
CREATE TRIGGER app_user_updated BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  timezone   text NOT NULL DEFAULT 'America/Los_Angeles',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'member', 'read_only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX membership_user_idx ON membership (user_id);

-- Login happens before any tenant is chosen, so the lookup by email is a controlled
-- exception to row-level security. It returns one user and nothing else.
CREATE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (id uuid, email text, name text, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.name, u.password_hash, u.is_active
  FROM app_user u
  WHERE u.email = lower(btrim(p_email))
$$;
REVOKE ALL ON FUNCTION auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup(text) TO crm_app;
