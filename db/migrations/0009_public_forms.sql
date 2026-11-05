-- 0009_public_forms: the public subscribe form and the unsubscribe link.
-- These run with no login, so each is a narrow SECURITY DEFINER function, like auth_lookup.
-- The app role can call these and nothing broader. A function can only do what its body says:
-- look a band up by its address, add or find one contact by email, and record consent.

-- A band by its address (the slug in the subscribe link).
CREATE FUNCTION public_tenant(p_slug text)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name FROM tenant t WHERE t.slug = lower(btrim(p_slug))
$$;

-- A person fills in the form. Returns what happened, so the caller can log it:
--   subscribed   a new subscription was recorded
--   unchanged    already subscribed
--   blocked      marked unsubscribed, bounced or suppressed. Left as it was and noted for a person
--   unknown_band, invalid
-- An address that unsubscribed is never put back by a form: nothing proves the person filling
-- it in owns the address. They can use the Undo link in the unsubscribe page, or ask a person.
CREATE FUNCTION public_subscribe(p_slug text, p_email text, p_first text, p_last text, p_consent text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant  uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_contact uuid;
  v_status  text;
BEGIN
  SELECT t.id INTO v_tenant FROM tenant t WHERE t.slug = lower(btrim(p_slug));
  IF v_tenant IS NULL THEN RETURN 'unknown_band'; END IF;
  IF v_email = '' OR length(v_email) > 320 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RETURN 'invalid'; END IF;

  SELECT c.id INTO v_contact FROM contact c
   WHERE c.tenant_id = v_tenant AND c.email = v_email AND c.archived_at IS NULL;
  IF v_contact IS NULL THEN
    BEGIN
      INSERT INTO contact (tenant_id, first_name, last_name, email, source)
      VALUES (v_tenant, left(nullif(btrim(p_first), ''), 200), left(nullif(btrim(p_last), ''), 200), v_email, 'Subscribe form')
      RETURNING id INTO v_contact;
    EXCEPTION WHEN unique_violation THEN
      SELECT c.id INTO v_contact FROM contact c
       WHERE c.tenant_id = v_tenant AND c.email = v_email AND c.archived_at IS NULL;
    END;
  END IF;

  SELECT s.status INTO v_status FROM subscription s WHERE s.tenant_id = v_tenant AND s.contact_id = v_contact;
  IF v_status IS NULL THEN
    INSERT INTO subscription (tenant_id, contact_id, status, consent_source, consented_at)
    VALUES (v_tenant, v_contact, 'subscribed', 'Subscribe form', now())
    ON CONFLICT (tenant_id, contact_id) DO NOTHING;
    INSERT INTO activity (tenant_id, kind, contact_id, body)
    VALUES (v_tenant, 'note', v_contact, 'Subscribed through the web form. They agreed to: ' || p_consent);
    RETURN 'subscribed';
  ELSIF v_status = 'subscribed' THEN
    RETURN 'unchanged';
  END IF;
  INSERT INTO activity (tenant_id, kind, contact_id, body)
  VALUES (v_tenant, 'note', v_contact,
          'Tried to subscribe through the web form, but is marked ' || v_status || '. Left as it was. Ask them to confirm before changing it.');
  RETURN 'blocked';
END
$$;

-- What the unsubscribe page shows for a contact id (already proven by a signed link).
CREATE FUNCTION public_contact_info(p_contact uuid)
RETURNS TABLE (band text, email text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.name, c.email, coalesce(s.status, 'none')
    FROM contact c
    JOIN tenant t ON t.id = c.tenant_id
    LEFT JOIN subscription s ON s.tenant_id = c.tenant_id AND s.contact_id = c.id
   WHERE c.id = p_contact
$$;

-- Unsubscribe, or undo an unsubscribe. Returns the new status, or null if there is no such contact.
-- Undo only works on 'unsubscribed', never on bounced or suppressed.
CREATE FUNCTION public_set_subscription(p_contact uuid, p_status text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_status text;
BEGIN
  IF p_status NOT IN ('unsubscribed', 'subscribed') THEN RAISE EXCEPTION 'bad status'; END IF;
  SELECT c.tenant_id INTO v_tenant FROM contact c WHERE c.id = p_contact;
  IF v_tenant IS NULL THEN RETURN NULL; END IF;
  SELECT s.status INTO v_status FROM subscription s WHERE s.tenant_id = v_tenant AND s.contact_id = p_contact;

  IF p_status = 'unsubscribed' THEN
    IF v_status IS DISTINCT FROM 'unsubscribed' THEN
      INSERT INTO subscription (tenant_id, contact_id, status, unsubscribed_at)
      VALUES (v_tenant, p_contact, 'unsubscribed', now())
      ON CONFLICT (tenant_id, contact_id) DO UPDATE SET status = 'unsubscribed', unsubscribed_at = now();
      INSERT INTO activity (tenant_id, kind, contact_id, body)
      VALUES (v_tenant, 'note', p_contact, 'Unsubscribed through the link in an email.');
    END IF;
    RETURN 'unsubscribed';
  END IF;

  IF v_status = 'unsubscribed' THEN
    UPDATE subscription SET status = 'subscribed', unsubscribed_at = NULL, consented_at = now(),
                            consent_source = 'Undid unsubscribe from the email link'
     WHERE tenant_id = v_tenant AND contact_id = p_contact;
    INSERT INTO activity (tenant_id, kind, contact_id, body)
    VALUES (v_tenant, 'note', p_contact, 'Undid the unsubscribe from the email link, so is subscribed again.');
    RETURN 'subscribed';
  END IF;
  RETURN coalesce(v_status, 'none');
END
$$;

REVOKE ALL ON FUNCTION public_tenant(text), public_subscribe(text, text, text, text, text),
                       public_contact_info(uuid), public_set_subscription(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_tenant(text), public_subscribe(text, text, text, text, text),
                          public_contact_info(uuid), public_set_subscription(uuid, text) TO crm_app;
