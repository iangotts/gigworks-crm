-- 0008_sessions: server-side login sessions.
-- Only the owner login (the backend's system path) touches this table. The app role gets no
-- access, so tenant-scoped queries can never read or forge a session.
-- The id is the SHA-256 of the cookie token, so a leaked table cannot be used to log in.

CREATE TABLE session (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  tenant_id    uuid REFERENCES tenant (id) ON DELETE SET NULL,   -- the tenant being worked in
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX session_user_idx    ON session (user_id);
CREATE INDEX session_expires_idx ON session (expires_at);

ALTER TABLE session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session FROM PUBLIC, crm_app;
