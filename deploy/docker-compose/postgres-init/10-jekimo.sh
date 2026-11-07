#!/bin/sh
# Runs once on an empty volume. Removes the superuser's password at the end so
# the setup-time admin credential is not retained (docs/database-setup.md).
set -eu

if [ -z "${JEKIMO_DB_PASSWORD:-}" ]; then
  echo "JEKIMO_DB_PASSWORD is not set; set it in .env before the first start" >&2
  exit 1
fi

# psql quotes :'jekimo_password', so the password never appears in SQL text.
psql -v ON_ERROR_STOP=1 -v jekimo_password="$JEKIMO_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE jekimo LOGIN PASSWORD :'jekimo_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE jekimo OWNER jekimo ENCODING 'UTF8';
REVOKE ALL ON DATABASE jekimo FROM PUBLIC;
GRANT CONNECT ON DATABASE jekimo TO jekimo;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname jekimo <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

# Socket access through `docker compose exec` still works for maintenance.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER ROLE \"$POSTGRES_USER\" PASSWORD NULL;"
