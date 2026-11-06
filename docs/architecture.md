# Architecture

Jekimo is planned as a self-hosted, multi-project service. Its first implementation uses a Node.js and TypeScript API, a background event worker, a React and TypeScript dashboard, a Node.js SDK, and PostgreSQL storage.

## Event flow

```text
Node.js SDK -> authenticated API -> durable queue -> worker -> PostgreSQL
                                                   -> dashboard query API
```

The event schema ([event-format.md](event-format.md)) and the ingestion protocol ([ingestion-protocol.md](ingestion-protocol.md)) are the public contracts shared across components. Every event, search, export, and issue action must be scoped to a project on the server; the rules are in [access-model.md](access-model.md). Project ingestion keys are separate from user sign-in credentials. Data lifetime, quotas, sampling, and disk safety are in [retention.md](retention.md).

## Deployment

Docker Compose will run the app on one VPS. Setup will connect an existing PostgreSQL datasource or provision PostgreSQL locally. Provisioning credentials are one-time setup secrets; runtime services use a restricted application account.

This document describes the intended design; implementation has not started.
