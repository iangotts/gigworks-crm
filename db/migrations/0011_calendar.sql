-- 0011_calendar: link members' Google calendars to show conflicts and put confirmed gigs on a calendar.

-- One Google sign-in per person. The refresh token is encrypted by the app before it is stored.
-- A person sees and changes only their own row. The server reads other members' rows through
-- a controlled path when it checks a gig date, and only for members of the active band.
CREATE TABLE calendar_connection (
  user_id           uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  google_email      text NOT NULL,
  refresh_token_enc text NOT NULL,
  status            text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_reconnect')),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER calendar_connection_updated BEFORE UPDATE ON calendar_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which of a person's calendars each band may check for conflicts. No row means not shared.
-- Kept apart from membership because only an admin can change membership.
CREATE TABLE calendar_share (
  user_id     uuid NOT NULL REFERENCES calendar_connection (user_id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  calendar_id text NOT NULL DEFAULT 'primary',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);

-- Where a band's confirmed gigs are written.
CREATE TABLE calendar_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES calendar_connection (user_id) ON DELETE CASCADE,
  calendar_id   text NOT NULL DEFAULT 'primary',
  timezone      text NOT NULL DEFAULT 'America/Los_Angeles',
  add_members   boolean NOT NULL DEFAULT false,  -- also put the event on shared members' calendars, with no invitation email
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER calendar_settings_updated BEFORE UPDATE ON calendar_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The event we created for a gig, so it is updated and removed rather than duplicated.
CREATE TABLE gig_calendar_event (
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  gig_id          uuid NOT NULL,
  google_event_id text NOT NULL,
  owner_user_id   uuid NOT NULL,
  calendar_id     text NOT NULL,
  html_link       text,
  content_hash    text NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gig_id),
  FOREIGN KEY (tenant_id, gig_id) REFERENCES gig (tenant_id, id) ON DELETE CASCADE
);
-- The latest sync problem for a gig, shown on the gig so it is not silent.
CREATE TABLE gig_calendar_problem (
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  gig_id     uuid NOT NULL,
  message    text NOT NULL,
  noted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gig_id),
  FOREIGN KEY (tenant_id, gig_id) REFERENCES gig (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gig_calendar_event', 'gig_calendar_problem'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO crm_app USING (tenant_id = ANY (visible_tenants()))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO crm_app WITH CHECK (tenant_id = ANY (visible_tenants()) AND writes_allowed())', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO crm_app USING (tenant_id = ANY (visible_tenants()) AND writes_allowed()) WITH CHECK (tenant_id = ANY (visible_tenants()) AND writes_allowed())', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO crm_app USING (tenant_id = ANY (visible_tenants()) AND writes_allowed())', t || '_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

-- Own-row access for the person tables.
ALTER TABLE calendar_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_connection_own ON calendar_connection FOR ALL TO crm_app
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_connection TO crm_app;

ALTER TABLE calendar_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_share FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_share_own ON calendar_share FOR ALL TO crm_app
  USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
-- Members can see who in their band shares a calendar, but not what calendar it is.
CREATE POLICY calendar_share_band_select ON calendar_share FOR SELECT TO crm_app
  USING (tenant_id = ANY (visible_tenants()));
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_share TO crm_app;

ALTER TABLE calendar_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_settings_select ON calendar_settings FOR SELECT TO crm_app USING (tenant_id = ANY (visible_tenants()));
CREATE POLICY calendar_settings_insert ON calendar_settings FOR INSERT TO crm_app
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin() AND owner_user_id = current_user_id());
CREATE POLICY calendar_settings_update ON calendar_settings FOR UPDATE TO crm_app
  USING (tenant_id = ANY (visible_tenants()) AND is_admin())
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin() AND owner_user_id = current_user_id());
CREATE POLICY calendar_settings_delete ON calendar_settings FOR DELETE TO crm_app
  USING (tenant_id = ANY (visible_tenants()) AND is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_settings TO crm_app;
