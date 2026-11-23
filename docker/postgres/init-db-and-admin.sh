#!/bin/sh
# ==============================================================================
# PostgreSQL First-Startup & Resumable Bootstrap
# 1. Acquires the shared migration advisory lock (42190837, matching
#    MIGRATION_ADVISORY_LOCK_KEY in packages/db/src/client.ts) and ensures
#    drizzle.__drizzle_migrations exists.
# 2. Applies each Drizzle SQL migration from /migrations (or MIGRATIONS_DIR)
#    and records its hash in drizzle.__drizzle_migrations inside ONE atomic
#    transaction per migration, skipping already-applied hashes so the script
#    can be safely re-run after an interrupted bootstrap.
# 3. Optionally creates an initial admin account when INITIAL_ADMIN_HANDLE and
#    INITIAL_ADMIN_PASSWORD (<= 72 UTF-8 bytes) are explicitly provided, using
#    pgcrypto bcrypt (compatible with @suite/auth-core) and ON CONFLICT DO NOTHING.
# ==============================================================================
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
JOURNAL_FILE="${MIGRATIONS_DIR}/meta/_journal.json"
MIGRATION_ADVISORY_LOCK_KEY="42190837"

echo "[kibitz-init] Ensuring drizzle migration tracking table exists..."
{
  printf 'BEGIN;\n'
  printf 'SELECT pg_advisory_xact_lock(%s);\n' "$MIGRATION_ADVISORY_LOCK_KEY"
  cat <<'SQL'
CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
COMMIT;
SQL
} | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"

if [ -f "$JOURNAL_FILE" ]; then
  # Extract (tag, when) pairs in journal order without external dependencies like jq.
  awk '
    /"when":/ {
      gsub(/[^0-9]/, "", $2)
      when = $2
    }
    /"tag":/ {
      gsub(/[",]/, "", $2)
      tag = $2
      if (tag != "" && when != "") {
        print tag " " when
        tag = ""
        when = ""
      }
    }
  ' "$JOURNAL_FILE" | while read -r tag when_ms; do
    sql_file="${MIGRATIONS_DIR}/${tag}.sql"
    if [ ! -f "$sql_file" ]; then
      echo "[kibitz-init] ERROR: Missing migration file ${sql_file}" >&2
      exit 1
    fi
    file_hash="$(sha256sum "$sql_file" | awk '{print $1}')"
    echo "[kibitz-init] Ensuring Drizzle migration ${tag}..."
    {
      printf 'BEGIN;\n'
      printf 'SELECT pg_advisory_xact_lock(%s);\n' "$MIGRATION_ADVISORY_LOCK_KEY"
      cat <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = :'migration_hash'
) AS already_applied \gset
\if :already_applied
\echo [kibitz-init] Skipping already-applied Drizzle migration :migration_tag
\else
SQL
      cat "$sql_file"
      printf '\n'
      cat <<'SQL'
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
VALUES (:'migration_hash', :'migration_when');
\endif
COMMIT;
SQL
    } | psql -v ON_ERROR_STOP=1 \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      -v migration_tag="$tag" \
      -v migration_hash="$file_hash" \
      -v migration_when="$when_ms"
  done
else
  echo "[kibitz-init] WARNING: No Drizzle journal found at ${JOURNAL_FILE}; skipping SQL migrations."
fi

trim_ws() {
  printf '%s' "$1" | tr '\r\n\t\v\f' '     ' | sed 's/^ *//;s/ *$//'
}

ADMIN_HANDLE="$(trim_ws "${INITIAL_ADMIN_HANDLE:-}")"
ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-}"
ADMIN_PASSWORD_TRIMMED="$(trim_ws "$ADMIN_PASSWORD")"

if [ -z "$ADMIN_HANDLE" ] || [ -z "$ADMIN_PASSWORD_TRIMMED" ]; then
  echo "[kibitz-init] INITIAL_ADMIN_HANDLE or INITIAL_ADMIN_PASSWORD is empty; skipping initial admin seed."
  exit 0
fi

ADMIN_PASSWORD_BYTES="$(printf '%s' "$ADMIN_PASSWORD" | wc -c | tr -d '[:space:]')"
if [ "$ADMIN_PASSWORD_BYTES" -gt 72 ]; then
  echo "[kibitz-init] ERROR: INITIAL_ADMIN_PASSWORD exceeds bcrypt's 72-byte UTF-8 limit (${ADMIN_PASSWORD_BYTES} bytes). Choose a password <= 72 UTF-8 bytes." >&2
  exit 1
fi

echo "[kibitz-init] Seeding initial admin account '${ADMIN_HANDLE}'..."
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v admin_handle="$ADMIN_HANDLE" \
  -v admin_password="$ADMIN_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "users" ("handle", "password_hash", "role")
VALUES (
  trim(:'admin_handle'),
  crypt(:'admin_password', gen_salt('bf', 12)),
  'admin'
)
ON CONFLICT (lower("handle")) DO NOTHING;
SQL

echo "[kibitz-init] Initial admin bootstrap complete."
