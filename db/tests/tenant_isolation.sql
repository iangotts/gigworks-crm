-- Tenant isolation tests. Everything runs in one transaction that is rolled back at the end,
-- so it leaves nothing behind. Run as the database owner (superuser or BYPASSRLS).
--   scripts/db.sh test
\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------- fixtures (as owner)
DO $$
DECLARE
  ta uuid; tb uuid; ua uuid; um uuid; uv uuid; ub uuid;
  va uuid; ca1 uuid; ca2 uuid; cb1 uuid; cb2 uuid; ga uuid;
BEGIN
  INSERT INTO tenant (name, slug) VALUES ('Test A', 'test-a') RETURNING id INTO ta;
  INSERT INTO tenant (name, slug) VALUES ('Test B', 'test-b') RETURNING id INTO tb;
  INSERT INTO app_user (email, name) VALUES ('t-admin@example.test',  'Admin both')   RETURNING id INTO ua;
  INSERT INTO app_user (email, name) VALUES ('t-member@example.test', 'Member A')     RETURNING id INTO um;
  INSERT INTO app_user (email, name, password_hash) VALUES ('t-viewer@example.test', 'Viewer A', 'secret') RETURNING id INTO uv;
  INSERT INTO app_user (email, name) VALUES ('t-onlyb@example.test',  'Only B')       RETURNING id INTO ub;
  INSERT INTO membership (tenant_id, user_id, role) VALUES
    (ta, ua, 'admin'), (tb, ua, 'admin'), (ta, um, 'member'), (ta, uv, 'read_only'), (tb, ub, 'member');
  INSERT INTO venue (tenant_id, name) VALUES (ta, 'Venue A') RETURNING id INTO va;
  INSERT INTO contact (tenant_id, first_name, email) VALUES (ta, 'A1', 'a1@example.test') RETURNING id INTO ca1;
  INSERT INTO contact (tenant_id, first_name, email) VALUES (ta, 'A2', 'a2@example.test') RETURNING id INTO ca2;
  INSERT INTO contact (tenant_id, first_name, email) VALUES (tb, 'B1', 'b1@example.test') RETURNING id INTO cb1;
  INSERT INTO contact (tenant_id, first_name, email) VALUES (tb, 'B2', 'b2@example.test') RETURNING id INTO cb2;
  INSERT INTO gig (tenant_id, title, venue_id, contact_id) VALUES (ta, 'Gig A', va, ca1) RETURNING id INTO ga;
  INSERT INTO gig (tenant_id, title) VALUES (tb, 'Gig B');

  PERFORM set_config('test.ta', ta::text, false);  PERFORM set_config('test.tb', tb::text, false);
  PERFORM set_config('test.ua', ua::text, false);  PERFORM set_config('test.um', um::text, false);
  PERFORM set_config('test.uv', uv::text, false);  PERFORM set_config('test.ub', ub::text, false);
  PERFORM set_config('test.cb1', cb1::text, false); PERFORM set_config('test.va', va::text, false);
  PERFORM set_config('test.ca1', ca1::text, false);
END $$;

-- ---------------------------------------------------------------- constraints (as owner)
DO $$
BEGIN
  -- a gig cannot point at another tenant's venue or contact
  BEGIN
    INSERT INTO gig (tenant_id, title, venue_id)
    VALUES (current_setting('test.tb')::uuid, 'Cross', current_setting('test.va')::uuid);
    RAISE EXCEPTION 'FAIL: gig in B accepted a venue from A';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO activity (tenant_id, kind, contact_id, body)
    VALUES (current_setting('test.tb')::uuid, 'note', current_setting('test.ca1')::uuid, 'x');
    RAISE EXCEPTION 'FAIL: activity in B accepted a contact from A';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- same email twice in one tenant is refused, in two tenants is fine
  BEGIN
    INSERT INTO contact (tenant_id, email) VALUES (current_setting('test.ta')::uuid, 'a1@example.test');
    RAISE EXCEPTION 'FAIL: duplicate email accepted inside one tenant';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO contact (tenant_id, email) VALUES (current_setting('test.tb')::uuid, 'a1@example.test');
  -- postponed only makes sense on confirmed gigs
  BEGIN
    INSERT INTO gig (tenant_id, title, stage, postponed)
    VALUES (current_setting('test.ta')::uuid, 'P', 'new', true);
    RAISE EXCEPTION 'FAIL: postponed accepted on a new gig';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: composite foreign keys, unique email per tenant, postponed check';
END $$;

-- ---------------------------------------------------------------- login lookup (no tenant context)
SET LOCAL ROLE crm_app;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM auth_lookup('  T-Admin@Example.test ');
  IF r.id IS NULL OR r.id <> current_setting('test.ua')::uuid THEN
    RAISE EXCEPTION 'FAIL: auth_lookup did not find the user case-insensitively';
  END IF;
  IF (SELECT count(*) FROM contact) <> 0 THEN
    RAISE EXCEPTION 'FAIL: contacts visible with no tenant set';
  END IF;
  RAISE NOTICE 'ok: auth_lookup works, no tenant context shows nothing';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------- member in tenant A
SELECT set_config('app.user_id',    current_setting('test.um'), true);
SELECT set_config('app.tenant_ids', current_setting('test.ta'), true);
SELECT set_config('app.role',       'member', true);
SET LOCAL ROLE crm_app;
DO $$
DECLARE n int;
BEGIN
  IF (SELECT count(*) FROM contact) <> 2 THEN RAISE EXCEPTION 'FAIL: member in A should see exactly 2 contacts'; END IF;
  IF (SELECT count(*) FROM contact WHERE tenant_id <> current_setting('test.ta')::uuid) <> 0 THEN
    RAISE EXCEPTION 'FAIL: member in A can see B contacts';
  END IF;
  IF (SELECT count(*) FROM gig) <> 1 OR (SELECT count(*) FROM venue) <> 1 THEN
    RAISE EXCEPTION 'FAIL: gigs or venues leaked across tenants';
  END IF;
  -- writes inside the tenant work
  INSERT INTO contact (tenant_id, first_name) VALUES (current_setting('test.ta')::uuid, 'New in A');
  -- writes into another tenant are refused
  BEGIN
    INSERT INTO contact (tenant_id, first_name) VALUES (current_setting('test.tb')::uuid, 'Sneaky');
    RAISE EXCEPTION 'FAIL: member in A inserted into B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- B's rows cannot be updated or deleted: they are invisible, so zero rows match
  UPDATE contact SET first_name = 'Hacked' WHERE id = current_setting('test.cb1')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: member in A updated a B contact'; END IF;
  DELETE FROM contact WHERE id = current_setting('test.cb1')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: member in A deleted a B contact'; END IF;
  -- moving a row into another tenant is refused
  BEGIN
    UPDATE contact SET tenant_id = current_setting('test.tb')::uuid WHERE first_name = 'A1';
    RAISE EXCEPTION 'FAIL: member moved a contact into B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- members cannot change memberships
  BEGIN
    INSERT INTO membership (tenant_id, user_id, role)
    VALUES (current_setting('test.ta')::uuid, current_setting('test.ub')::uuid, 'admin');
    RAISE EXCEPTION 'FAIL: member added a membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- people: sees A's people, not B-only people, and never password hashes
  IF (SELECT count(*) FROM app_user WHERE email = 't-onlyb@example.test') <> 0 THEN
    RAISE EXCEPTION 'FAIL: user who is only in B is visible from A';
  END IF;
  IF (SELECT count(*) FROM app_user) <> 3 THEN RAISE EXCEPTION 'FAIL: expected 3 people in tenant A'; END IF;
  BEGIN
    PERFORM password_hash FROM app_user;
    RAISE EXCEPTION 'FAIL: password_hash readable by the app role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- the import tables are closed
  BEGIN
    PERFORM 1 FROM import_mapping;
    RAISE EXCEPTION 'FAIL: app role can read import_mapping';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: member sees and writes only tenant A, cannot touch memberships, hashes or import tables';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------- read-only user in tenant A
SELECT set_config('app.user_id', current_setting('test.uv'), true);
SELECT set_config('app.role',    'read_only', true);
SET LOCAL ROLE crm_app;
DO $$
DECLARE n int;
BEGIN
  IF (SELECT count(*) FROM contact) <> 3 THEN RAISE EXCEPTION 'FAIL: read-only user cannot read tenant A'; END IF;
  BEGIN
    INSERT INTO contact (tenant_id, first_name) VALUES (current_setting('test.ta')::uuid, 'Nope');
    RAISE EXCEPTION 'FAIL: read-only user inserted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE contact SET first_name = 'Nope';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: read-only user updated % rows', n; END IF;
  DELETE FROM contact;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: read-only user deleted % rows', n; END IF;
  RAISE NOTICE 'ok: read-only user can read and cannot write';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------- admin in both tenants
-- Tenant switcher: before a tenant is chosen, the user sees only the tenants they belong to.
SELECT set_config('app.user_id',    current_setting('test.ua'), true);
SELECT set_config('app.tenant_ids', '', true);
SELECT set_config('app.role',       '', true);
SET LOCAL ROLE crm_app;
DO $$
BEGIN
  IF (SELECT count(*) FROM tenant WHERE slug IN ('test-a', 'test-b')) <> 2 THEN
    RAISE EXCEPTION 'FAIL: tenant switcher should list both tenants for the admin';
  END IF;
  IF (SELECT count(*) FROM membership WHERE user_id = current_user_id()) <> 2 THEN
    RAISE EXCEPTION 'FAIL: user should see their own two memberships';
  END IF;
  IF (SELECT count(*) FROM contact) <> 0 THEN
    RAISE EXCEPTION 'FAIL: contacts visible before a tenant is chosen';
  END IF;
  RAISE NOTICE 'ok: tenant switcher lists own tenants and shows no data until one is chosen';
END $$;
RESET ROLE;

-- Combined view (the later phase): both tenant ids in the context.
SELECT set_config('app.tenant_ids', current_setting('test.ta') || ',' || current_setting('test.tb'), true);
SELECT set_config('app.role',       'admin', true);
SET LOCAL ROLE crm_app;
DO $$
BEGIN
  IF (SELECT count(DISTINCT tenant_id) FROM contact) <> 2 THEN
    RAISE EXCEPTION 'FAIL: combined view should span both tenants';
  END IF;
  INSERT INTO membership (tenant_id, user_id, role)
  VALUES (current_setting('test.tb')::uuid, current_setting('test.um')::uuid, 'member');
  RAISE NOTICE 'ok: admin with two tenants sees both and can manage memberships';
END $$;
RESET ROLE;

-- A user in only one tenant cannot widen their own view by guessing the other id: the
-- backend decides the context, so this guards the backend rule, not the database rule.
-- (Documented in the README. The database trusts app.tenant_ids once it is set.)

ROLLBACK;
