#!/usr/bin/env bash
# Database helper. Needs psql and DATABASE_URL (a login that owns the database).
#   scripts/db.sh migrate   apply any migrations not yet applied
#   scripts/db.sh seed      load tenants and import rules
#   scripts/db.sh test      run the tenant-isolation tests
#   scripts/db.sh status    list applied migrations
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL, e.g. postgres://user:pass@localhost:5432/gigworks_crm}"
cd "$(dirname "$0")/.."
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q)

migrate() {
  "${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  for f in db/migrations/*.sql; do
    v=$(basename "$f" .sql)
    done_already=$("${PSQL[@]}" -tA -c "SELECT 1 FROM schema_migrations WHERE version = '$v'")
    if [ -z "$done_already" ]; then
      echo "applying $v"
      "${PSQL[@]}" --single-transaction -f "$f" \
        -c "INSERT INTO schema_migrations (version) VALUES ('$v')"
    fi
  done
  echo "migrations up to date"
}

case "${1:-}" in
  migrate) migrate ;;
  seed)    "${PSQL[@]}" -f db/seeds/001_tenants_and_import_rules.sql && echo "seeded" ;;
  test)    "${PSQL[@]}" -f db/tests/tenant_isolation.sql && echo "all isolation tests passed" ;;
  status)  "${PSQL[@]}" -c "SELECT version, applied_at FROM schema_migrations ORDER BY version" ;;
  *) echo "usage: $0 migrate|seed|test|status" >&2; exit 2 ;;
esac
