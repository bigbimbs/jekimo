#!/bin/sh
# Runs once, when the postgres service starts with an empty data volume
# (local-db profile). Creates the restricted application account and its
# database, then removes the superuser's password so the setup-time
# administrator credential cannot be used again over the network.
# Privileges: packages/storage-postgres/README.md, "Database privileges".
# Design: docs/database-setup.md.
set -eu

if [ -z "${JEKIMO_DB_PASSWORD:-}" ]; then
  echo "JEKIMO_DB_PASSWORD is not set; set it in .env before the first start" >&2
  exit 1
fi

# The password is passed as a psql variable and quoted by psql (:'name'), so
# it is never interpolated into SQL text or printed.
psql -v ON_ERROR_STOP=1 -v jekimo_password="$JEKIMO_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE jekimo LOGIN PASSWORD :'jekimo_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE jekimo OWNER jekimo ENCODING 'UTF8';
REVOKE ALL ON DATABASE jekimo FROM PUBLIC;
GRANT CONNECT ON DATABASE jekimo TO jekimo;
-- No access to any other database.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL

# In PostgreSQL 15 and later the public schema belongs to the database owner,
# so jekimo can create its tables there. Nobody else may.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname jekimo <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

# The superuser keeps local (socket) access inside the container for
# maintenance through `docker compose exec`, but has no password any more.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER ROLE \"$POSTGRES_USER\" PASSWORD NULL;"
