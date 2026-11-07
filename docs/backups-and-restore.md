# Backups and restore

This page shows how to back up a Jekimo instance installed with the production Compose file ([install-vps.md](install-vps.md)), copy the backup off the server, restore it into a fresh database, and run a restore drill. Commands run in `/opt/jekimo`, the directory with `docker-compose.yml` and `.env`.

> **Status.** Jekimo has no built-in backup job yet; the procedure below uses `pg_dump` and `pg_restore` directly and works today. The planned nightly job, with its manifest and bucket upload, is described at the end.

## What a backup contains

- A compressed logical dump of the PostgreSQL database (`pg_dump --format=custom`): events in the hot tier, issues, projects, users, memberships, settings, daily counters, ingestion key hashes, password hashes, the audit log, and the queue.
- A manifest next to it: the dump's SHA-256 checksum, the Jekimo version, and the schema migration level, so you know which release can read it.

Backups never contain plaintext ingestion keys or passwords. They do contain event data, which may include personal data your applications sent, and must be stored privately and encrypted when they leave the server.

Also keep a private copy of `.env` and `docker-compose.override.yml`, if you have one: the dump does not contain the database password or your settings.

## Take a backup

### Option 1: local PostgreSQL in Compose

```bash
mkdir -p /opt/jekimo/backups && chmod 700 /opt/jekimo/backups
cd /opt/jekimo
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T postgres pg_dump -U jekimo -d jekimo --format=custom > "backups/jekimo-$stamp.dump"
{
  echo "file: jekimo-$stamp.dump"
  echo "sha256: $(sha256sum "backups/jekimo-$stamp.dump" | cut -d' ' -f1)"
  echo "jekimo_version: $(grep '^JEKIMO_VERSION=' .env | cut -d= -f2)"
  echo "migration: $(docker compose exec -T postgres psql -U jekimo -d jekimo -tAc 'SELECT max(name) FROM schema_migrations')"
} > "backups/jekimo-$stamp.manifest"
cat "backups/jekimo-$stamp.manifest"
```

`pg_dump` takes a consistent snapshot while Jekimo keeps running; there is no need to stop the services. It runs inside the `postgres` container as the `jekimo` account over the local socket, so no password is involved.

To run it every night at 02:30 UTC, save the commands above as `/opt/jekimo/backup.sh` (starting with `#!/bin/sh` and `set -eu`), make it executable, and add a cron entry for the user that runs Docker:

```bash
chmod 700 /opt/jekimo/backup.sh
( crontab -l 2>/dev/null; echo '30 2 * * * /opt/jekimo/backup.sh >> /opt/jekimo/backups/backup.log 2>&1' ) | crontab -
```

Delete old local dumps so they do not fill the disk, for example keeping 7 days:

```bash
find /opt/jekimo/backups -name 'jekimo-*' -mtime +7 -delete
```

### Option 2: an existing PostgreSQL server

Your existing database backups already cover Jekimo. To take a Jekimo-only dump as well, run the same `pg_dump` from any machine that can reach the server, as the `jekimo` account or an administrator, with `--format=custom`, and write the manifest the same way using `psql` against the server.

## Copy it off the server

A backup on the VPS's own disk does not survive losing the VPS, its disk, or the account. Copy every dump and manifest to another machine or provider every day, encrypted. Two common ways:

- `rsync` over SSH to a machine you control: `rsync -a --chmod=F600 /opt/jekimo/backups/ backup@backup.example.com:jekimo/`.
- [restic](https://restic.net/) to any S3-compatible bucket or SFTP target, which encrypts and deduplicates: `restic -r s3:https://s3.example.com/jekimo-backups backup /opt/jekimo/backups`.

Keep at least 14 daily and 6 monthly copies off the server (the defaults the planned bucket backups will use), and check now and then that the copies are arriving.

## Verify a backup

Check that the dump matches its manifest and that `pg_restore` can read it:

```bash
f=backups/jekimo-20261107T023000Z.dump
grep '^sha256:' "${f%.dump}.manifest" | cut -d' ' -f2 | sed "s|\$|  $f|" | sha256sum -c -
docker compose exec -T postgres pg_restore --list < "$f" | head
```

The restore drill below is the real test.

## Restore into a fresh database

Use this after losing the database, on a new server, or to roll back an upgrade. Events received after the backup was taken are lost.

1. Install Jekimo as in [install-vps.md](install-vps.md) sections 1 to 8 with the **same `JEKIMO_VERSION` as in the manifest**, or reuse the existing installation. Restore your copy of `.env` if you have one.
2. Stop everything that writes to the database:

   ```bash
   docker compose stop caddy api worker
   ```

3. Replace the database with an empty one owned by the `jekimo` account (Option 1; with Option 2, run the same SQL on your server as an administrator):

   ```bash
   docker compose exec -T postgres dropdb -U postgres jekimo
   docker compose exec -T postgres createdb -U postgres --owner=jekimo jekimo
   docker compose exec -T postgres psql -U postgres -d jekimo -c "REVOKE ALL ON SCHEMA public FROM PUBLIC"
   ```

4. Restore the dump as the `jekimo` account, so it owns every table:

   ```bash
   docker compose exec -T postgres pg_restore -U jekimo -d jekimo --no-owner --exit-on-error < backups/jekimo-20261107T023000Z.dump
   ```

5. Apply any migrations newer than the dump (needed when the installed version is newer than the manifest's), and create upcoming event partitions:

   ```bash
   docker compose run --rm migrate
   ```

6. Start the services and check them:

   ```bash
   docker compose up -d --wait
   docker compose ps -a
   ```

7. Sign in and query a project, or send a test event ([install-vps.md](install-vps.md) section 10). Ingestion keys and passwords from the backup work again because their hashes were restored.

## Restore drill

Run this every month, and after every upgrade, so you know the backups work before you need them. It restores the latest dump into a scratch database next to the live one and does not touch the running instance.

```bash
f="$(ls -t backups/jekimo-*.dump | head -n 1)"
docker compose exec -T postgres createdb -U postgres --owner=jekimo jekimo_restore_drill
docker compose exec -T postgres pg_restore -U jekimo -d jekimo_restore_drill --no-owner --exit-on-error < "$f"
docker compose exec -T postgres psql -U jekimo -d jekimo_restore_drill -c \
  "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM projects) AS projects, (SELECT count(*) FROM events) AS events, (SELECT max(name) FROM schema_migrations) AS migration"
docker compose exec -T postgres dropdb -U postgres jekimo_restore_drill
```

The drill passes when `pg_restore` finishes without an error and the counts look plausible against the live instance. Restore a copy fetched from off the server, not only the local one, at least every few months. With Option 2, run the drill on a scratch database on your server.

## Planned: built-in backups and object storage (Phase 2)

- A nightly backup job will write the dump and its manifest to a local backup directory, or, with an object store configured, upload them under the `v1/backups/` prefix, keeping `JEKIMO_BACKUP_KEEP_DAILY` (14) daily and `JEKIMO_BACKUP_KEEP_MONTHLY` (6) monthly dumps ([object-storage.md](object-storage.md#backups)).
- **Not covered by the dump:** events already archived to the cold tier live only in the bucket under each project's prefix. Protecting the bucket (versioning, replication, or provider-side backup) is the operator's responsibility.
- **Restore with a bucket:** restore the dump as above, then reconnect the instance to the same bucket (the same `JEKIMO_OBJECT_STORE_*` settings) so archived days and older backups remain reachable. This page will gain the exact steps when object storage is implemented.
