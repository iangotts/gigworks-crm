-- 0007_row_level_security: tenant isolation, enforced by Postgres and not only by the app.
-- FORCE means even the table owner is subject to the policies. Superusers still bypass RLS,
-- so the app must run as crm_app (SET LOCAL ROLE crm_app) on every request.

-- Tables that carry tenant_id and are fully tenant-scoped.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'venue', 'contact', 'subscription', 'gig', 'contact_role', 'gig_member', 'payment',
    'activity', 'link_target', 'outbound_link', 'link_click', 'template'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO crm_app USING (tenant_id = ANY (visible_tenants()))',
                   t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO crm_app WITH CHECK (tenant_id = ANY (visible_tenants()) AND writes_allowed())',
                   t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO crm_app USING (tenant_id = ANY (visible_tenants()) AND writes_allowed()) WITH CHECK (tenant_id = ANY (visible_tenants()) AND writes_allowed())',
                   t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO crm_app USING (tenant_id = ANY (visible_tenants()) AND writes_allowed())',
                   t || '_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

-- tenant: you can see the tenants you are a member of (for the tenant switcher) and the
-- one you are working in. The app role cannot create or change tenants.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON tenant FOR SELECT TO crm_app
  USING (id = ANY (visible_tenants())
         OR EXISTS (SELECT 1 FROM membership m WHERE m.tenant_id = tenant.id AND m.user_id = current_user_id()));
GRANT SELECT ON tenant TO crm_app;

-- membership: you see your own memberships and everyone's in the tenant you are working in.
-- Only an admin can add, change or remove members.
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_select ON membership FOR SELECT TO crm_app
  USING (tenant_id = ANY (visible_tenants()) OR user_id = current_user_id());
CREATE POLICY membership_insert ON membership FOR INSERT TO crm_app
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin());
CREATE POLICY membership_update ON membership FOR UPDATE TO crm_app
  USING (tenant_id = ANY (visible_tenants()) AND is_admin())
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin());
CREATE POLICY membership_delete ON membership FOR DELETE TO crm_app
  USING (tenant_id = ANY (visible_tenants()) AND is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON membership TO crm_app;

-- app_user: you see yourself and the people who share the tenant you are working in.
-- You can change only your own name and password hash. New users are created by an admin
-- tool running as the owner, not through the app role.
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY app_user_select ON app_user FOR SELECT TO crm_app
  USING (id = current_user_id()
         OR EXISTS (SELECT 1 FROM membership m
                    WHERE m.user_id = app_user.id AND m.tenant_id = ANY (visible_tenants())));
CREATE POLICY app_user_update ON app_user FOR UPDATE TO crm_app
  USING (id = current_user_id()) WITH CHECK (id = current_user_id());
GRANT SELECT (id, email, name, is_active, created_at, updated_at) ON app_user TO crm_app;
GRANT UPDATE (name, password_hash) ON app_user TO crm_app;

-- Import tables: closed to the app role. No grants, and RLS with no policy as a second lock.
ALTER TABLE import_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_id_map  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON import_mapping, import_id_map FROM PUBLIC, crm_app;
