# Phase 5 — Results, reports, retention and notifications

This implements Section 32, Phase 5 of Architecture.md for **local testing**.
Phase 6 is not started. Private Google Cloud Storage remains pending: its SDK
installation was declined. The current private filesystem adapter is restricted
to explicit local mock mode. Email sending is deferred by your choice to use
in-app notices for now.

## Approved policy

- Retention target: 30 days.
- Deletion: **manual only**. Passing 30 days does not delete anything.
- Notice lead time: 2 days for any future scheduled deletion.
- Local notification channel: in-app. The configured Gmail address is a future
  recipient, not a sender. No SMTP credentials or Google OAuth client are needed.
- Explicitly confirmed project deletion is processed immediately in the
  background. Download your export before confirming. There is no automatic
  deletion countdown or fabricated deletion notice under the manual policy.

`AUTOMATIC_RETENTION_APPROVED=false`, `RETENTION_NOTICE_DAYS=2`,
`EMAIL_PROVIDER=disabled`, and the recipient are set in the local `.env`.
Existing credentials are preserved. Automatic retention code cannot run unless
its global approval switch and a project automatic policy are both enabled;
neither is enabled for local use.

## Start and obtain real IDs without a load test

Use the existing PostgreSQL database and `.env` from prior phases:

```sh
npm run db:migrate
npm run build
npm run phase5:seed
```

The last command creates an isolated **synthetic** project and prints its real
`projectId`, `planId`, `runId`, and `notificationId`. It does not call Groq,
Docker, Redis, or a target application. Its target is disabled, its plan is
archived and unreviewed, and all resulting reports identify the source as
`fixture`. Each invocation creates a new fixture project.

Start these in separate terminals, from the repository root:

```sh
npm run start:dev
```

```sh
npm run start:phase5
```

The API and processor must use the same PostgreSQL database, `WORKER_HOST_ID`,
`RESULT_STAGING_DIR`, and `ARTIFACTS_DIR`. These defaults are in `.env.example`.
The Phase 5 processor uploads results and processes deletion requests; it never
executes a load test. Wait until the run API returns `resultStatus: "ready"`.

Optionally run `npm run start:web`. Load the fixture plan ID, enter its run ID,
and select **Refresh run status** to view results. Project data controls show
notices, export, and explicit deletion confirmation.

For **real, separately approved load tests**, keep the Phase 4 API/Redis/worker
setup, rebuild its image using the new tag, and also start the Phase 5 processor:

```sh
docker build -f apps/worker/docker/Dockerfile -t performance-k6:1.8.2-phase5 .
```

Set `K6_WORKER_IMAGE=performance-k6:1.8.2-phase5`. This image writes bounded
raw NDJSON and an end-of-test summary to the private staging directory.
Old runs without captured results remain `unavailable`; they are never rerun
to generate reports.

## Postman

Import [phase-5.postman_collection.json](./phase-5.postman_collection.json).
Use **No Auth** and set:

| Variable | Value |
|---|---|
| baseUrl | http://127.0.0.1:3000/api/v1 |
| projectId | Printed fixture project UUID, or an accessible existing project |
| planId | Printed fixture plan UUID |
| runId | Printed fixture run UUID, or a newly captured real run |

The collection saves report, download, export, and notification IDs automatically.
Run requests in order after processing is ready. No login token is needed.
Signed artifact URLs contain a short-lived download capability; this is not an
identity token. Download immediately, or issue a fresh link after expiry.

The main collection never confirms deletion or approves a load test. Its SLA
example changes thresholds for **future approvals only**. Use the separate
[deletion collection](./phase-5-deletion.postman_collection.json) only after
saving your backup.

## Endpoints and expected responses

All paths below are relative to `baseUrl`. No body is needed unless shown.
JSON bodies require `Content-Type: application/json`.

### Read results

`GET /runs/{{runId}}` → **200**. Existing run fields are preserved; the new fields
for the synthetic fixture include:

```json
{
  "resultStatus": "ready",
  "resultFailureCode": null,
  "summary": {
    "source": "fixture",
    "requests": 20,
    "requestsPerSecond": 2,
    "errorRate": 0.05,
    "checkPassRate": 0.95,
    "latencyMs": { "average": 100, "median": 100, "p95": 100, "p99": 100 },
    "durationMs": 10000,
    "slaStatus": "not_configured",
    "slaThresholds": {},
    "findings": [
      "Synthetic fixture data; no load test was executed.",
      "Recorded 20 HTTP requests.",
      "SLA status: not_configured."
    ]
  }
}
```

This is the new portion of the response, not the full run envelope.
Metrics missing from real output remain `null`; they are not reported as zero.
Rates use fractions: `0.05` means 5%. SLA thresholds are snapshotted when a run
is approved, so later edits cannot change old results. A partial failed or
cancelled run cannot receive a passing SLA evaluation.

Result processing states: `pending`, `ready`, `failed`, `unavailable`.
Run execution status remains a separate field.

### Reports, artifacts and downloads

`GET /runs/{{runId}}/reports` → **200**:

```json
{
  "runId": "<actual run UUID>",
  "resultStatus": "ready",
  "items": [
    {
      "id": "<report UUID>",
      "format": "html",
      "artifactId": "<artifact UUID>",
      "createdAt": "<UTC timestamp>",
      "sha256": "<actual SHA-256>",
      "sizeBytes": "<byte count>"
    },
    {
      "id": "<report UUID>",
      "format": "json",
      "artifactId": "<artifact UUID>",
      "createdAt": "<UTC timestamp>",
      "sha256": "<actual SHA-256>",
      "sizeBytes": "<byte count>"
    }
  ]
}
```

An unprocessed run has an empty `items` array. HTML is escaped and contains no
active scripts. Reports contain measured summaries and deterministic findings;
Groq remains the planning provider and is not used to invent result metrics.

`GET /projects/{{projectId}}/artifacts` → **200**, `{ "items": [...] }`.
A ready run has five artifact kinds: `script`, `raw_results`, `run_summary`,
`report_json`, and `report_html`. Metadata includes checksum, size, content type,
and the 30-day retention target (`deleteAfter`); this timestamp alone never
authorizes deletion. Lists expose neither internal filesystem paths nor keys.

`POST /artifacts/{{artifactId}}/download-link` → **200**:

```json
{
  "artifactId": "<actual artifact UUID>",
  "url": "http://127.0.0.1:3000/api/v1/artifacts/<UUID>/content?token=<signed capability>",
  "expiresAt": "<UTC timestamp>",
  "sha256": "<actual SHA-256>"
}
```

`GET <returned url>` → **200**, file attachment with its actual content type.
Default expiry is 60 seconds, capped at 300. Every download rechecks project
access and verifies the bytes against their size and checksum. Expired/altered
links return **403**; unavailable artifacts/projects return **404**.

### SLA and comparison

`GET /projects/{{projectId}}/sla` → **200** with `thresholds: {}` initially.

`PUT /projects/{{projectId}}/sla`:

```json
{ "p95ResponseTimeMs": 250, "maxErrorRate": 0.01 }
```

→ **200**:

```json
{
  "projectId": "<actual project UUID>",
  "thresholds": { "p95ResponseTimeMs": 250, "maxErrorRate": 0.01 },
  "appliesTo": "future_run_approvals"
}
```

These thresholds are examples to test validation, not approved production SLAs.
Use `{}` to clear them. Null, negative, and error-rate values above 1 return 400.

`GET /runs/{{runId}}/comparison?baselineRunId={{runId}}` → **200** after processing.
Comparing the fixture to itself returns `comparable: true` and zero deltas for
`requestsPerSecond`, `errorRate`, and `p95ResponseTimeMs`. For real comparisons,
use another processed run in the same project. Deltas are candidate minus
baseline; different scripts or synthetic/measured sources are flagged.
Missing results return **409**.

### Retention and notices

`GET /projects/{{projectId}}/retention` → **200**:

```json
{
  "projectId": "<actual project UUID>",
  "retentionDays": 30,
  "noticeDays": 2,
  "deletionMode": "manual",
  "channels": ["in_app"],
  "notificationEmail": "<configured future recipient, or null>",
  "automaticDeletionEnabled": false,
  "scope": "completed_run_data_and_artifacts",
  "notices": []
}
```

To persist the approved manual policy, `PUT /projects/{{projectId}}/retention`:

```json
{ "retentionDays": 30, "noticeDays": 2, "deletionMode": "manual", "channels": ["in_app"] }
```

→ **200**, same policy shape. Automatic mode is rejected with **409** under the
approved configuration. Do not enable its global switch for Postman testing.

`GET /projects/{{projectId}}/notifications` → **200**, `{ "items": [...] }`.
The fixture supplies a synthetic in-app notice without a scheduled deletion date.
An ordinary project with no notices returns an empty list.
`POST /notifications/{{notificationId}}/read` → **200**,
`{ "id": "<UUID>", "readAt": "<UTC timestamp>" }`; repeated calls preserve readAt.
The response includes the latest 100 notification records.

### Export before deletion

`POST /projects/{{projectId}}/exports` → **201**:

```json
{
  "projectId": "<actual project UUID>",
  "artifactId": "<export artifact UUID>",
  "format": "json",
  "sha256": "<actual SHA-256>",
  "sizeBytes": 12345
}
```

Byte count varies. Obtain a download link for this artifact, GET that URL,
then save the response to disk. The JSON contains `schemaVersion: 1`, project,
plans, versions, runs, summaries, and original artifact bytes as `contentBase64`.
Prior exports are excluded. This is a user backup format, not a full database
restore tool. Exports are bounded (64 MiB by default) and remain until explicit
project deletion; manual retention does not delete them.

### Explicit deletion — separate collection

First verify the intended project ID and save the downloaded export.
Import the deletion collection and set `projectId` and
`confirmProjectDeletion=true`. Its confirmation request skips by default.

`POST /projects/{{projectId}}/deletion-requests`:

```json
{ "confirmed": true }
```

→ **202**, `{ "id": "<deletion request UUID>", "status": "pending" }`.
Project access is revoked immediately. Queued runs are cancelled; running or
cancelling tests cause **409** until safely stopped. A repeated request returns
the same request and current status. Missing/false confirmation returns **400**.

`GET /deletion-requests/{{deletionRequestId}}` → **200**:

```json
{
  "id": "<deletion request UUID>",
  "projectId": "<project UUID>",
  "status": "completed",
  "attempts": 0,
  "failureCode": null,
  "createdAt": "<UTC timestamp>",
  "completedAt": "<UTC timestamp>"
}
```

Poll while `pending` or `retrying`. The processor removes artifact bytes,
staging data, reports, summaries, runs, plans/versions, targets, policies,
notifications and membership. Completion is recorded only after all removals.
Minimal audit identifiers/timestamps, an anonymized project row, deletion status,
and idempotency tombstones remain. The fixed shared local identity is retained.
Reusing an already deleted run's idempotency key returns **410**, never new load.
Downloaded copies outside the application are not removed.

### Retry failed result processing

`POST /runs/{{runId}}/results/retry` → **202** only for failed processing with
retained source data:

```json
{ "runId": "<run UUID>", "resultStatus": "pending", "loadTestRerun": false }
```

A ready/pending/unavailable run returns **409**. This endpoint does not enqueue
or execute k6. Automatic processing retries are bounded at five attempts.

## Verification and remaining integration work

Tests use real SQL with embedded PostgreSQL (PGlite), private temporary files,
and local HTTP. They cover normalization of k6 summary formats, missing metrics,
HTML escaping, processing retries, checksums, link expiry/revocation, isolation,
export bytes, deletion retries, and notice-before-deletion gating. Automatic
retention and email delivery are exercised only with isolated test policies and
mock email adapters; they are disabled in the approved local configuration.

The Playwright browser check uses mocked APIs and covers result retries,
report/export downloads through the local proxy, notice acknowledgement,
explicit deletion confirmation/status, safe text rendering, and desktop/mobile layout.

Docker/k6 and Redis are mocked in tests because Docker is unavailable here.
The Google Cloud Storage adapter and cloud deployment verification remain
pending. Local files do not provide managed cloud encryption at rest.
Email delivery requires a later provider/sender decision and credentials.
No email was sent and no real load test was executed during implementation.
