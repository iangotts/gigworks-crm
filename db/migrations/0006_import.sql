-- 0006_import: rules and id bookkeeping for the one-time GW-GIG import.
-- These tables are for the import script only. The app role gets no access to them.

-- Rules: which Bubble band becomes which tenant, and which status becomes which stage.
CREATE TABLE import_mapping (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('band', 'status')),
  source_value text NOT NULL,
  tenant_id    uuid REFERENCES tenant (id) ON DELETE CASCADE,   -- for kind = band
  target_value text,                                            -- for kind = status
  note         text,
  UNIQUE (kind, source_value),
  CHECK ((kind = 'band' AND tenant_id IS NOT NULL) OR (kind = 'status' AND target_value IS NOT NULL))
);

-- Every GW-GIG record that was imported, and the new record it became. The same Bubble fan
-- can map to two rows, one per tenant. Re-running the import uses this to avoid duplicates
-- and to link child rows to their parents.
CREATE TABLE import_id_map (
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  source_table text NOT NULL,
  legacy_id    text NOT NULL,
  target_table text NOT NULL,
  target_id    uuid NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_table, legacy_id)
);
CREATE INDEX import_id_map_target_idx ON import_id_map (target_table, target_id);
