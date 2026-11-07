# VPS deployment

This directory will contain the Docker Compose deployment for the API, worker, web dashboard, and optional local PostgreSQL service.

The installer will support connecting to an existing PostgreSQL datasource or provisioning a local database and restricted application account. Keep secrets outside version control and document backup, restore, upgrade, and credential rotation procedures.

`docker-compose.dev.yml` runs PostgreSQL 16, a one-shot migration job, the API, and the worker for local development, with every port bound to loopback. It is not a production deployment. See [docs/local-development.md](../../docs/local-development.md).

The production VPS deployment has not been added yet.
