-- 0010_email: one-to-one email sent from the CRM.
-- Each band sets who the mail comes from and where replies go. Every send is saved in the
-- activity log with the provider's message id, so bounces and replies can be matched later.

CREATE TABLE email_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  from_name  text NOT NULL,
  from_email text NOT NULL,   -- must be a verified sender at the email provider
  reply_to   text NOT NULL,   -- the mailbox that reads the replies
  signature  text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_email ~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$'),
  CHECK (reply_to   ~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$'),
  CHECK (from_name !~ '[\r\n<>"]')
);
CREATE TRIGGER email_settings_updated BEFORE UPDATE ON email_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY email_settings_select ON email_settings FOR SELECT TO crm_app
  USING (tenant_id = ANY (visible_tenants()));
CREATE POLICY email_settings_insert ON email_settings FOR INSERT TO crm_app
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin());
CREATE POLICY email_settings_update ON email_settings FOR UPDATE TO crm_app
  USING (tenant_id = ANY (visible_tenants()) AND is_admin())
  WITH CHECK (tenant_id = ANY (visible_tenants()) AND is_admin());
GRANT SELECT, INSERT, UPDATE ON email_settings TO crm_app;

ALTER TABLE activity
  ADD COLUMN subject             text,
  ADD COLUMN email_to            text,
  ADD COLUMN delivery            text CHECK (delivery IN ('sending', 'sent', 'failed')),
  ADD COLUMN delivery_error      text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN request_id          uuid,
  ADD CHECK (kind = 'email' OR (subject IS NULL AND email_to IS NULL AND delivery IS NULL AND request_id IS NULL));
-- A double click or a retry carries the same request id, so it can never send twice.
CREATE UNIQUE INDEX activity_request_key ON activity (tenant_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX activity_provider_msg_idx ON activity (provider_message_id) WHERE provider_message_id IS NOT NULL;
