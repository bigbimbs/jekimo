# Backups and restore

Backup and restore procedures are not implemented yet. This page records what the release guide must cover.

## What a backup contains

- A compressed logical dump of the PostgreSQL database: events in the hot tier, issues, projects, users, memberships, settings, ingestion key hashes, password hashes, and the audit log.
- A manifest with the dump's checksum, the Jekimo version, and the schema migration level.

Backups never contain plaintext ingestion keys or passwords. They do contain event data and must be stored privately.

## Where backups go

- With an object store configured, nightly dumps are uploaded under the `v1/backups/` prefix with the retention described in [object-storage.md](object-storage.md).
- Without one, dumps are written to the local backup directory. The install guide must tell operators to copy them off the VPS.

## What a backup does not cover

Events already archived to the cold tier are not in the dump; they live in the bucket under each project's prefix. Protecting the bucket (versioning, replication, or provider-side backup) is the operator's responsibility and must be documented.

## Restore

The guide must cover: restoring a dump into a fresh database, running migrations if the dump predates the installed version, verifying integrity, and reconnecting the instance to an existing bucket so archived days and backups remain reachable. Operators should run a restore drill monthly.
