-- Seed: the two tenants and the import rules agreed on 5 Nov 2026.
-- Safe to run more than once. Run as the database owner, not as crm_app.

INSERT INTO tenant (name, slug) VALUES
  ('Jane Blonde and the Goldfingers', 'janeblonde'),
  ('ROCKSOLID', 'rocksolid')
ON CONFLICT (slug) DO NOTHING;

-- Bubble band id -> tenant. Every other Bubble band is excluded from the import.
INSERT INTO import_mapping (kind, source_value, tenant_id, note)
SELECT 'band', v.band_id, t.id, v.note
FROM (VALUES
  ('1656301311474x890873913412157400', 'janeblonde', 'Jane Blonde and the Goldfingers'),
  ('1779605988768x536068923494760450', 'rocksolid',  'ROCKSOLID. No gigs or fans under this id in GW-GIG, so it starts empty.')
) AS v(band_id, slug, note)
JOIN tenant t ON t.slug = v.slug
ON CONFLICT (kind, source_value) DO NOTHING;

-- GW-GIG gig status -> GW-CRM stage.
INSERT INTO import_mapping (kind, source_value, target_value, note) VALUES
  ('status', 'PITCH',       'new',             NULL),
  ('status', 'ON THE LIST', 'evaluating',      NULL),
  ('status', 'IN-PROCESS',  'in_conversation', NULL),
  ('status', 'CONTRACTED',  'confirmed',       NULL),
  ('status', 'PERFORMED',   'played',          NULL),
  ('status', 'POSTPONED',   'confirmed',       'also set gig.postponed = true'),
  ('status', 'CANCELED',    'lost',            'also set gig.lost_reason = canceled'),
  ('status', 'LOST',        'lost',            NULL),
  ('status', '',            'new',             'blank status: flag the gig for review')
ON CONFLICT (kind, source_value) DO NOTHING;
