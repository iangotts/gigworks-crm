-- 0005_activity_links_templates: the activity log, tracked links and message templates.

-- One log for calls, voicemails, texts, emails, notes and follow-up tasks.
-- GW-GIG fan notes, gig notes and gig actions all land here.
CREATE TABLE activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('call', 'voicemail', 'text', 'email', 'note', 'task')),
  contact_id   uuid,
  gig_id       uuid,
  body         text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz,            -- tasks only
  completed_at timestamptz,            -- tasks only
  created_by   uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'task' OR (due_at IS NULL AND completed_at IS NULL)),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, gig_id)     REFERENCES gig (tenant_id, id)     ON DELETE CASCADE
);
CREATE INDEX activity_contact_idx ON activity (tenant_id, contact_id, occurred_at DESC);
CREATE INDEX activity_gig_idx     ON activity (tenant_id, gig_id, occurred_at DESC);
CREATE INDEX activity_open_task_idx ON activity (tenant_id, due_at)
  WHERE kind = 'task' AND completed_at IS NULL;

-- The band's shareable links: website, promo video, setlist, testimonials.
CREATE TABLE link_target (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name       text NOT NULL,
  url        text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- A link sent to one contact, tagged with standard UTM parameters.
CREATE TABLE outbound_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  contact_id      uuid,
  link_target_id  uuid,
  gig_id          uuid,
  destination_url text NOT NULL,       -- the full URL including the UTM parameters
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  created_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)     REFERENCES contact (tenant_id, id)     ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, link_target_id) REFERENCES link_target (tenant_id, id) ON DELETE SET NULL (link_target_id),
  FOREIGN KEY (tenant_id, gig_id)         REFERENCES gig (tenant_id, id)         ON DELETE SET NULL (gig_id)
);
CREATE INDEX outbound_link_contact_idx ON outbound_link (tenant_id, contact_id);

-- Clicks. GW-GIG history is imported here. New clicks may be added by hand or by the
-- analytics tool, once that is chosen.
CREATE TABLE link_click (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  outbound_link_id uuid NOT NULL,
  clicked_at       timestamptz NOT NULL,
  origin           text NOT NULL DEFAULT 'import' CHECK (origin IN ('import', 'manual', 'analytics')),
  FOREIGN KEY (tenant_id, outbound_link_id) REFERENCES outbound_link (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX link_click_link_idx ON link_click (tenant_id, outbound_link_id, clicked_at DESC);

CREATE TABLE template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('decline', 'pitch', 'follow_up', 'other')),
  subject     text,
  body        text NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER template_updated BEFORE UPDATE ON template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
