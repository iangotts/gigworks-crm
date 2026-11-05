-- 0003_contacts_venues: contacts are the prospects. Venues are a light reference list.
-- Every tenant table carries tenant_id and has UNIQUE (tenant_id, id) so that child tables can
-- use composite foreign keys. That makes a cross-tenant link impossible, not just hidden.

CREATE TABLE venue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name       text NOT NULL,
  city       text,
  address    text,
  website    text,
  phone      text,
  type       text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX venue_name_idx ON venue (tenant_id, lower(name));
CREATE TRIGGER venue_updated BEFORE UPDATE ON venue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  first_name  text,
  last_name   text,
  email       text CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> '')),
  phone       text,
  company     text,
  job_title   text,
  address     text,
  city        text,
  source      text,
  is_local    boolean,
  -- free labels such as festival-organizer, venue-organizer, event-organizer, rocksolid
  tags        text[] NOT NULL DEFAULT '{}',
  notes       text,
  archived_at timestamptz,
  created_by  uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- One contact per email address within a tenant. The import merges duplicates first.
CREATE UNIQUE INDEX contact_email_key ON contact (tenant_id, email)
  WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX contact_name_idx ON contact (tenant_id, lower(last_name), lower(first_name));
CREATE INDEX contact_tags_idx ON contact USING gin (tags);
CREATE TRIGGER contact_updated BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Marketing consent per contact. Unsubscribed and suppressed contacts stay in the table
-- so they can never be mailed again by mistake.
CREATE TABLE subscription (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  contact_id      uuid NOT NULL,
  status          text NOT NULL DEFAULT 'subscribed'
                  CHECK (status IN ('subscribed', 'unsubscribed', 'bounced', 'suppressed')),
  consent_source  text,
  consented_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX subscription_status_idx ON subscription (tenant_id, status);
CREATE TRIGGER subscription_updated BEFORE UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
