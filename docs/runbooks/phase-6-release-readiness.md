# Phase 6 — Local release-readiness runbook

This runbook covers the current local profile. It does not claim cloud
deployment readiness. Cloud service selection, operational ownership, backup
objectives, and staging network policy are tracked in
[the cloud deployment decision](../phase-6-cloud-decision.md).

## Health checks

- `GET /api/v1/health` is a liveness check. It confirms the API process responds
  and intentionally does not depend on PostgreSQL.
- `GET /api/v1/health/ready` is a readiness check. It runs `SELECT 1` against
  PostgreSQL and returns `503` with `database_unavailable` if the database
  cannot be reached. Do not route traffic to an instance that is not ready.
- These endpoints do not establish worker, Redis, artifact-store, or AI-provider
  health. Those dependencies require separate operational telemetry before a
  production alerting configuration is approved.

## Local database backup and restore verification

Use an authorized local PostgreSQL account. Keep connection strings and
passwords in environment variables or a protected local environment file; do
not paste credentials into command history, logs, or this repository.

Create a point-in-time database dump:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path '.\backups' $stamp
New-Item -ItemType Directory -Force $backupDir | Out-Null
pg_dump --format=custom --no-owner --no-acl --file (Join-Path $backupDir 'database.dump') $env:DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
Get-FileHash (Join-Path $backupDir 'database.dump') -Algorithm SHA256
pg_restore --list (Join-Path $backupDir 'database.dump') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup archive verification failed' }
```

The local filesystem artifact store and result staging directory must be backed
up consistently with the database. Quiesce the API and Phase 5 processor before
copying these directories, or use an appropriate filesystem snapshot. Store
the copies separately from the live data and protect them with encrypted
storage and access controls. A project JSON export is useful for user recovery,
but is not a full database restore.

Verify a restore only into a new, disposable database. Confirm the restore URL
before running the command; never use the live `DATABASE_URL` as
`RESTORE_DATABASE_URL`.

```powershell
if (-not $env:RESTORE_DATABASE_URL) { throw 'Set RESTORE_DATABASE_URL to a new disposable database' }
pg_restore --no-owner --no-acl --dbname $env:RESTORE_DATABASE_URL (Join-Path $backupDir 'database.dump')
if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed' }
```

After restoring, verify the migration ledger and representative project,
plan, run, and artifact metadata. A database-only restore does not restore
filesystem artifact bytes; restore the matching artifact and result-staging
backup before validating downloads. Record the backup timestamp, archive hash,
restore database, and outcome in the team's approved operational record.

## Release and rollback safeguards

1. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and
   `npm run build` on the exact candidate revision.
2. Scan TypeScript with CodeQL, dependencies with `npm audit`, and the hardened
   k6 worker image with Trivy using the repository workflows. Resolve
   high/critical findings or document an approved exception before release.
3. Back up the database and artifact bytes before a schema or storage change.
4. Apply migrations using the controlled migration command. Use expand/migrate/
   contract sequencing; do not roll back a destructive migration by restoring
   an old database over live data.
5. Keep the prior immutable application and worker images available. If a
   release fails, stop new approvals, return traffic to the prior application
   revision, and retain run state for investigation. Do not replay a run that
   had already started.
6. Platform-specific deployment, rollback, and restore steps must be completed
   and reviewed by the named operational owner before staging.

## Capacity and alerting gates

- Do not use a public or third-party target for capacity testing. Use only a
  controlled target whose owner has approved the test and workload.
- Start with the existing isolated tests and mocked worker/runtime tests.
  Any actual staging run requires explicit target authorization, configured
  workload ceilings, and approval through the normal run API.
- Before staging, define dashboard panels and alerts for API readiness/error
  rate, oldest queued/outbox age, active worker capacity, stuck/cancelling runs,
  result-processing failures, artifact-storage failures, and database/Redis
  availability.
- Alert thresholds, notification routes, and response ownership are not set;
  do not invent production SLOs. Record approved thresholds with the operations
  owner and platform decision.
