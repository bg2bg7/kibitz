#!/bin/sh
# ==============================================================================
# PostgreSQL First-Startup Bootstrap (runs only on an empty PGDATA volume)
# 1. Applies all Drizzle SQL migrations mounted at /migrations and records them
#    in drizzle.__drizzle_migrations so `pnpm db:migrate` stays in sync.
# 2. Creates the default admin account from INITIAL_ADMIN_HANDLE and
#    INITIAL_ADMIN_PASSWORD using pgcrypto bcrypt (compatible with @suite/auth-core).
# ==============================================================================
set -eu

MIGRATIONS_DIR="/migrations"
JOURNAL_FILE="${MIGRATIONS_DIR}/meta/_journal.json"

echo "[kibitz-init] Ensuring drizzle migration tracking table exists..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
SQL

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
    echo "[kibitz-init] Applying Drizzle migration ${tag}..."
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$sql_file"
    psql -v ON_ERROR_STOP=1 \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      -v migration_hash="$file_hash" \
      -v migration_when="$when_ms" <<'SQL'
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
VALUES (:'migration_hash', :'migration_when');
SQL
  done
else
  echo "[kibitz-init] WARNING: No Drizzle journal found at ${JOURNAL_FILE}; skipping SQL migrations."
fi

ADMIN_HANDLE="${INITIAL_ADMIN_HANDLE:-}"
ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-}"

if [ -z "$ADMIN_HANDLE" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "[kibitz-init] INITIAL_ADMIN_HANDLE or INITIAL_ADMIN_PASSWORD is empty; skipping default admin seed."
  exit 0
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

echo "[kibitz-init] Default admin bootstrap complete."
