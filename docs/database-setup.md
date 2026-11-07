# Database setup

This page specifies how an installation gets its PostgreSQL database: connecting an existing server, or provisioning one on the VPS. It covers both flows step by step, the two database accounts involved, how one-time administrator credentials are kept out of the running instance, the checks that run before setup completes, rollback, TLS, and credential rotation.

It refines the README, "Database setup options", and step 3 of the setup flow in [access-model.md](access-model.md#setup-flow).

> **Status: design.** Part of this already works with the production Compose file ([install-vps.md](install-vps.md)): the local-db profile provisions PostgreSQL with a restricted account and drops the superuser password, and an existing database is connected through a pre-created account. The `jekimo-setup-db` command described below, which uses administrator credentials once to create the account on an existing server and runs the checks, is not implemented yet. Sections say which parts exist.

## Terms

| Term | Meaning |
| --- | --- |
| **Runtime account** | The PostgreSQL role the API, the worker, and migrations connect as, `jekimo` by default. It is the only database credential the running instance has. |
| **Admin account** | A PostgreSQL role with enough rights to create the runtime account and its database: a superuser, or a role with `CREATEROLE` and `CREATEDB`. Used at most once, during setup, and never retained. |
| **Jekimo database** | The database the runtime account owns, `jekimo` by default. Jekimo uses its `public` schema. |
| **Connection string** | `JEKIMO_DATABASE_URL`: the runtime account's credentials and the server address, kept in the deployment's `.env` ([configuration.md](configuration.md#database)). |

## Accounts and privileges

### Runtime account

The privileges are those in [`packages/storage-postgres/README.md`](../packages/storage-postgres/README.md#database-privileges):

- `LOGIN`, with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
- Owner of the Jekimo database, so that in PostgreSQL 15 and later it owns the `public` schema (`pg_database_owner`) and can create tables, indexes, functions, and daily partitions in it.
- Owner of every table Jekimo creates; detaching and dropping expired partitions requires ownership. Creating the tables as this account gives it ownership.
- `CONNECT` on the Jekimo database only. `PUBLIC` loses `CONNECT` on the maintenance database (`postgres`) where setup provisions the server, and loses every privilege on the Jekimo database's `public` schema.
- No extensions. Advisory locks, used by the migration runner, are available to every account.

The first release runs migrations as the runtime account, which is why it owns the schema. A later release may split a migration owner from a runtime role with only `SELECT`, `INSERT`, `UPDATE`, and `DELETE`; that split will be specified here before it is implemented.

### Admin account

Needed only by the flows that create the runtime account (A2 and B). The minimum is:

| Right | Used for |
| --- | --- |
| `CREATEROLE` | `CREATE ROLE jekimo LOGIN PASSWORD ...` and, on failure, `DROP ROLE`. |
| `CREATEDB` | `CREATE DATABASE jekimo OWNER jekimo` and, on failure, `DROP DATABASE`. From PostgreSQL 16 a non-superuser may only make a role it can `SET ROLE` to a database owner, so setup grants itself `jekimo WITH SET TRUE` (allowed because a `CREATEROLE` role holds `ADMIN OPTION` on roles it creates) and revokes that grant once the database exists. |
| `CONNECT` on `postgres` (or another maintenance database) | Somewhere to connect before the Jekimo database exists. |

A superuser also works. Setup never needs `REPLICATION`, `BYPASSRLS`, or file-system access, and never changes server settings or `pg_hba.conf`.

## Flows

Pick one per installation. All three end in the same state: a connection string for the runtime account in `.env`, a migrated Jekimo database, and no administrator credential anywhere in the instance.

### Flow A1: existing server, account created by the operator (works today)

1. The operator creates the runtime account and database with the SQL in [install-vps.md](install-vps.md#option-2-an-existing-postgresql-server), using their own administrator session. Jekimo never sees the administrator credential.
2. The operator writes `JEKIMO_DATABASE_URL` for the runtime account into `.env`, with the TLS parameters from [TLS](#tls-for-an-existing-database).
3. The `migrate` service runs the pre-flight checks below that apply to the runtime account (connectivity, TLS, version, privileges), then applies migrations. **Today** it applies migrations only; the checks are part of `jekimo-setup-db check`, planned.
4. The API starts and prints the setup token; the setup page shows the database it is connected to (host, database, account, TLS mode, PostgreSQL version) for the operator to confirm. It never shows the password.

### Flow A2: existing server, account created by Jekimo with admin credentials used once (planned)

For an operator who has an administrator login on an existing server (on the VPS or elsewhere) and wants Jekimo to create the restricted account.

1. Before the first start, the operator runs the one-shot setup command in a throwaway container:

   ```bash
   docker compose run --rm -it migrate jekimo-setup-db provision --host db.example.com --admin-user postgres
   ```

2. The command reads the admin password from the terminal with echo off (or from standard input when it is not a terminal). It never accepts the password as a command-line argument or an environment variable, because both are visible to other processes and are recorded by Docker.
3. It runs the [pre-flight checks](#pre-flight-checks) for the admin connection.
4. It generates the runtime password: 32 random bytes, hex-encoded so it needs no escaping in a URL.
5. It provisions, recording each object it creates in an in-memory list:
   1. `CREATE ROLE jekimo LOGIN PASSWORD $1 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` (the password is sent as a parameter or quoted by the driver, never formatted into SQL text that could be logged).
   2. For a non-superuser admin on PostgreSQL 16 or later: `GRANT jekimo TO <admin> WITH SET TRUE`.
   3. `CREATE DATABASE jekimo OWNER jekimo ENCODING 'UTF8'`, then revokes the grant from step 2.
   4. `REVOKE ALL ON DATABASE jekimo FROM PUBLIC`, `GRANT CONNECT ON DATABASE jekimo TO jekimo`, and in the new database `REVOKE ALL ON SCHEMA public FROM PUBLIC`.
6. It connects as the runtime account, runs the runtime checks, and applies migrations as that account. The admin connection stays open until this succeeds, because [rollback](#rollback) needs it.
7. It closes the admin connection and discards the admin password: the variable is overwritten and dropped, and the process keeps no reference to it. Nothing after this step can use it.
8. It writes `JEKIMO_DATABASE_URL` into `.env` atomically (write a temporary file with mode `0600` in the same directory, `fsync`, rename) and prints the database, host, account, and TLS mode, not the password.
9. The container exits and is removed (`--rm`), so its file system and memory are gone.

The runtime password is not shown on screen: the only copy is in `.env`, which the operator already protects. An operator who wants it in a password manager reads it from `.env`.

### Flow B: local PostgreSQL provisioned on the VPS (works today, through Compose)

1. The operator sets `COMPOSE_PROFILES=local-db`, `JEKIMO_DB_PASSWORD` (the runtime password), and `POSTGRES_ADMIN_PASSWORD` (the superuser password) in `.env`; both from `openssl rand -hex 32`.
2. `docker compose up -d` starts the `postgres` service on an empty volume. The PostgreSQL image initialises the cluster with the superuser password, then runs [`deploy/docker-compose/postgres-init/10-jekimo.sh`](../deploy/docker-compose/postgres-init/10-jekimo.sh) once. The script creates the runtime account and database as in A2 step 5 (as the superuser, so without the step 2 grant), revokes `PUBLIC`'s `CONNECT` on `postgres`, and runs `ALTER ROLE postgres PASSWORD NULL`.
3. From then on the superuser cannot log in over the network at all; it can only be reached through the container's local socket with `docker compose exec postgres psql -U postgres`, which already requires control of Docker on the host. `POSTGRES_ADMIN_PASSWORD` is never read again, and the guide tells the operator to delete it from `.env`.
4. The API, worker, and `migrate` services receive only `JEKIMO_DATABASE_URL` for the runtime account. The Compose file lists each service's variables explicitly and does not use `env_file`, so the superuser password cannot reach them by accident. `docker compose config` shows this.
5. The `postgres` service publishes no host port; only containers on the Compose network reach it.

If initialisation fails (for example `JEKIMO_DB_PASSWORD` is empty), the script exits non-zero, the container stops, and the half-initialised volume is reported in the log. The guide tells the operator to fix `.env` and remove the volume (`docker compose down -v`) before starting again; a new installation has no data to lose. `jekimo-setup-db` will automate this for the A2 case.

## Pre-flight checks

Run before anything is created (admin connection) and again before setup completes (runtime connection). Each failure stops setup with a message that names the check and the fix, never the password or the full connection string.

| Check | Admin connection | Runtime connection | Fails when |
| --- | --- | --- | --- |
| Connect within 10 s | yes | yes | DNS, network, firewall, `pg_hba.conf`, or authentication fails. The message gives the PostgreSQL error code and class, not the driver text, which can contain host names and user names. |
| TLS as requested | yes | yes | The server does not offer TLS when `sslmode` requires it, or the certificate does not verify. |
| Server version | yes | yes | `server_version_num` is below 130000 (no built-in `gen_random_uuid()`). Setup warns below 140000; CI and the Compose file use 16. |
| Admin rights | yes | — | `rolsuper` is false and either `rolcreaterole` or `rolcreatedb` is false. |
| Names free | yes | — | Role `jekimo` or database `jekimo` already exists. The operator chooses other names with `--role` and `--database`, or uses flow A1. Setup never takes over existing objects. |
| Not over-privileged | — | yes | `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolreplication`, or `rolbypassrls` is true for `current_user`. Setup refuses to finish with an account that can do more than it needs. |
| Schema rights | — | yes | `has_schema_privilege(current_user, 'public', 'CREATE')` is false, or `current_user` does not own the database. |
| Write test | — | yes | Creating, writing, and dropping a temporary table in `public` inside a rolled-back transaction fails. |
| Migrations | — | yes | Any migration fails; the runner already applies each file in its own transaction and stops at the first error. |

The not-over-privileged check also runs at every start of the API and the worker once implemented, logging a warning (not refusing to start, so an operator who deliberately uses a broader role in flow A1 is not locked out) and showing a banner to instance admins.

## Rollback

Setup never leaves a partly provisioned installation:

- Before A2 step 5 nothing has been created, so a failed check needs no clean-up.
- `CREATE DATABASE` cannot run inside a transaction, so provisioning keeps the list of objects it created in this run and, on any later failure (including a failed runtime check or migration), drops them in reverse order with the admin connection: `DROP DATABASE IF EXISTS jekimo`, then `DROP ROLE IF EXISTS jekimo`. Objects that existed before the run are never dropped; the names-free check guarantees there are none.
- Because rollback needs the admin connection, it stays open until the runtime checks and migrations have passed (A2 step 6), and is closed and discarded only then.
- `.env` is written only after everything has passed, so a failed run leaves no connection string that points at a half-built database.
- If the process is killed mid-run, the next `jekimo-setup-db provision` finds the leftover objects through the names-free check and offers `jekimo-setup-db rollback --role jekimo --database jekimo`, which drops them only if the database contains no Jekimo users yet.

## How non-retention is guaranteed

Administrator credentials must not be written to disk, environment variables, logs, or the database. Each channel is closed by design and checked by a test or a command the operator can run:

| Channel | Design | Check |
| --- | --- | --- |
| Command line | Never accepted as an argument. | `ps` shows no password; a unit test asserts the argument parser has no password option. |
| Environment | Never read from the environment by `jekimo-setup-db`. In flow B the superuser password exists only in the `postgres` container's environment, is used once by the image's initialisation, and is nulled in the database. | `docker compose config` shows that `api`, `worker`, and `migrate` receive no admin variable. `docker compose exec api env` lists only the runtime connection string. |
| Disk | Held in memory only; the setup container is removed on exit. `.env` receives the runtime connection string only. | An integration test provisions a throwaway server and searches `.env`, the container file system, and the Compose project for the admin password. |
| Logs | Logs name the host, database, role, and check, never a password or connection string. Driver errors are reduced to type and code, as `/readyz` already does. | The same integration test searches all service logs for the admin password and the runtime password. |
| Database | The admin password is never stored. After flow B the superuser has no password (`rolpassword IS NULL`); after flow A2 the admin account is untouched and Jekimo holds no reference to it. The audit log records `database.provisioned` with host, database, role, and TLS mode only. | `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user` as the runtime account returns `false` for every right. |

## TLS for an existing database

The connection string carries the TLS options; node-postgres reads them:

| `sslmode` | Use when |
| --- | --- |
| `verify-full` | **Recommended** for any server reached over a network. Encrypts and checks that the certificate chains to a trusted CA and matches the host name. |
| `verify-ca` | The certificate is checked against `sslrootcert`, but not the host name. Only with a private CA. |
| `require` | Encrypts without verifying. Acceptable only on a private network you trust. node-postgres 8 currently treats `require` like `verify-full` and prints a deprecation warning; add `uselibpqcompat=true` for the libpq meaning. |
| `disable` | Only for a server on the same host or the Compose network (flow B), never across a network. |

- A private CA is mounted read-only into the `api`, `worker`, and `migrate` containers with a Compose override file and referenced with `sslrootcert=/run/jekimo/db-ca.crt` ([install-vps.md](install-vps.md#tls-to-an-existing-database)).
- Client certificate authentication uses `sslcert` and `sslkey` the same way; the key file must be readable by the container user (`node`, UID 1000) and nobody else.
- The server's `pg_hba.conf` should accept the runtime account with `hostssl ... scram-sha-256` only.

## Credential rotation

### Runtime account password

Works today, with no data loss and a restart of a few seconds:

1. Generate a new password: `openssl rand -hex 32`.
2. Set it on the server, as an administrator or as the runtime account itself (an account may change its own password):
   - Flow B: `docker compose exec postgres psql -U postgres -c "ALTER ROLE jekimo PASSWORD '<new password>'"`.
   - Flows A1 and A2: the same `ALTER ROLE` from the operator's administrator session.
3. Update `.env`: `JEKIMO_DB_PASSWORD` (flow B) or the password in `JEKIMO_DATABASE_URL` (flows A1 and A2).
4. Recreate the services so they read it: `docker compose up -d`.

Connections already open keep working; new connections opened between steps 2 and 4 fail, so some requests may get `503` and SDKs retry. `jekimo-setup-db rotate`, planned, will do steps 1 to 3 with the runtime account's own connection and no admin credential.

### Admin credentials

Jekimo never holds them, so rotating them needs no change to Jekimo. In flow B there is no superuser password to rotate; an operator who needs one sets it through `docker compose exec postgres psql -U postgres` and removes it again afterwards.

### After a suspected leak

Rotate the runtime password as above, then review the audit log and `pg_stat_activity` for connections from unexpected addresses.
