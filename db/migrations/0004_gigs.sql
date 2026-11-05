-- 0004_gigs: gigs with the lead block, contact roles, band members on a gig, and payments.
-- Stages are the eight GW-GIG statuses folded to six, with postponed as a flag on confirmed.

CREATE TABLE gig (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  venue_id        uuid,
  contact_id      uuid,                 -- main booking contact
  title           text NOT NULL,
  stage           text NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new', 'evaluating', 'in_conversation', 'confirmed', 'played', 'lost')),
  postponed       boolean NOT NULL DEFAULT false CHECK (NOT postponed OR stage = 'confirmed'),
  lost_reason     text,
  event_date      date,
  load_in_time    time,
  start_time      time,
  end_time        time,
  -- lead block
  event_type      text,
  platform        text,                 -- where the lead came from: Bark, GigSalad, Network, website
  lead_url        text,
  indoor_outdoor  text CHECK (indoor_outdoor IN ('indoor', 'outdoor', 'both')),
  hours           numeric(4,1),
  budget          numeric(10,2),
  verified_phone  boolean NOT NULL DEFAULT false,
  credits_spent   integer NOT NULL DEFAULT 0,
  drive_miles     numeric(6,1),
  band_pitched    text,
  decision        text CHECK (decision IN ('pursue', 'decline')),
  decline_reason  text,
  next_action_at  timestamptz,
  reply_owed_by   date,
  -- money
  fee_quoted      numeric(10,2),
  fee_note        text,                 -- fee text that is not a plain number, kept as typed
  -- housekeeping
  tag             text,
  notes           text,
  archived_at     timestamptz,
  created_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, venue_id)   REFERENCES venue (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id)
);
CREATE INDEX gig_stage_idx   ON gig (tenant_id, stage) WHERE archived_at IS NULL;
CREATE INDEX gig_date_idx    ON gig (tenant_id, event_date);
CREATE INDEX gig_followup_idx ON gig (tenant_id, next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX gig_reply_idx   ON gig (tenant_id, reply_owed_by) WHERE reply_owed_by IS NOT NULL;
CREATE TRIGGER gig_updated BEFORE UPDATE ON gig
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A contact's part in a gig or at a venue, or their status as a band member.
-- The label is the free text that was typed in GW-GIG, kept as is.
CREATE TABLE contact_role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  contact_id uuid NOT NULL,
  kind       text NOT NULL DEFAULT 'other'
             CHECK (kind IN ('booking_manager', 'organizer', 'client', 'sound',
                             'musician', 'band_member', 'venue_staff', 'other')),
  label      text,
  venue_id   uuid,
  gig_id     uuid,
  status     text CHECK (status IN ('active', 'sub', 'inactive')),
  pay_amount numeric(10,2),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IS NULL OR kind IN ('band_member', 'musician')),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, venue_id)   REFERENCES venue (tenant_id, id)   ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, gig_id)     REFERENCES gig (tenant_id, id)     ON DELETE CASCADE
);
CREATE INDEX contact_role_contact_idx ON contact_role (tenant_id, contact_id);
CREATE INDEX contact_role_gig_idx     ON contact_role (tenant_id, gig_id) WHERE gig_id IS NOT NULL;
CREATE INDEX contact_role_venue_idx   ON contact_role (tenant_id, venue_id) WHERE venue_id IS NOT NULL;
CREATE TRIGGER contact_role_updated BEFORE UPDATE ON contact_role
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which of our own band members play a gig, and whether they confirmed.
CREATE TABLE gig_member (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  gig_id        uuid NOT NULL,
  membership_id uuid NOT NULL,
  confirmed     boolean,               -- null = not answered yet
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gig_id, membership_id),
  FOREIGN KEY (tenant_id, gig_id)        REFERENCES gig (tenant_id, id)        ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES membership (tenant_id, id) ON DELETE CASCADE
);

-- Deposit and balance only. No ledgers.
CREATE TABLE payment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  gig_id     uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('deposit', 'balance', 'other')),
  amount     numeric(10,2) NOT NULL CHECK (amount >= 0),
  due_on     date,
  paid_on    date,
  method     text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, gig_id) REFERENCES gig (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX payment_gig_idx ON payment (tenant_id, gig_id);
CREATE TRIGGER payment_updated BEFORE UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
