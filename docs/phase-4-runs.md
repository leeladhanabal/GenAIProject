# Phase 4 — Run orchestration and k6 workers

This implements **Section 32, Phase 4** of `Architecture.md`. Section 4,
“Proposed Solution,” is the overview. Phase 5 local results are now available;
see [the Phase 5 guide](./phase-5-results.md) for result capture and processor startup.

## Delivered behavior

- Run approval, status, cancellation, and run-policy APIs scoped to the fixed local user.
- Durable PostgreSQL run snapshots, approval audit events, and transactional outbox.
- Redis/BullMQ delivery, reconciliation of missing queue jobs, and atomic worker claims.
- One isolated k6 container per run, with bounded CPU, memory, process count,
  duration, request rate, and total generated requests.
- Execution-time authorization and DNS checks. The local Docker profile pins one
  public IPv4 address, disables redirects/IPv6, and permits outbound traffic only
  to that address on HTTPS port 443. DNS cannot redirect a running test elsewhere.
- Cancellation and crash recovery with execution tokens. A started run is never
  automatically replayed. Recovery confirms container removal before releasing
  its capacity reservation.
- React approval/status/cancellation UI, with separate authorization and approval
  checkboxes and displayed workload ceilings.

Cloud Run/GKE selection and cloud network deployment remain architecture
decisions. This phase provides a **local Docker worker profile**, not a cloud
deployment. Reports, result analysis/storage, retention, and notifications remain
Phase 5. With the Phase 5 upgrade, status responses include results after processing.

## Prerequisites and configuration

Keep the PostgreSQL database, fixed local user, project, target, and plan from
Phases 2–3. Install Docker Engine or Docker Desktop with Linux containers. The
worker orchestrator runs as a separate Node process on the Docker host. The API
does not receive Docker access. Each Docker daemon needs its own stable
`WORKER_HOST_ID`; use the same ID after restarting workers on that daemon.

The API and worker must use the same database and approved workload policy.
Configure `.env` locally; existing secrets are preserved by the implementation.

```dotenv
AUTH_MODE=local-mock
NODE_ENV=development
MAX_VIRTUAL_USERS=<approved positive integer>
MAX_DURATION_SECONDS=<approved positive integer>
MAX_REQUESTS_PER_SECOND=<approved positive integer>
MAX_REQUESTS_PER_RUN=<approved positive integer>
MAX_CONCURRENT_RUNS=5
REDIS_URL=redis://127.0.0.1:6379/0
WORKER_HOST_ID=local-docker
K6_WORKER_IMAGE=performance-k6:1.8.2-phase5
WORKER_CPUS=1
WORKER_MEMORY_MB=512
WORKER_PIDS_LIMIT=128
```

Angle-bracket values are instructions, not valid `.env` numbers. There are no
default load ceilings for VUs, duration, request rate, or total requests. Select
the numeric limits approved for your target before testing. The examples below
use a reviewed plan of **1 VU for at most 10 seconds**; your configured ceilings
must allow it. `MAX_REQUESTS_PER_RUN` must allow at least
`virtualUsers × scenarioCount` requests.

The architecture caps concurrency at five; configuration above five is rejected.
To bound the backlog, queued, running, and cancelling runs **together** reserve
at most `MAX_CONCURRENT_RUNS` slots across the service. Additional approvals
return 429 until a slot is free. Queued jobs reserve capacity even when Redis or
workers are unavailable, and can be cancelled through the API.

CPU, memory, and process values above are configurable local container resource
caps. Rootless Docker and IPv6-only targets are not supported by this profile.
Firewall setup fails closed if the required Linux network capabilities are
unavailable. Setup briefly uses root to install per-container firewall rules;
the watchdog and k6 then run as UID 10001 with every capability removed.

## Start locally

From the repository root:

```sh
npm install
npm run db:migrate
docker compose -f compose.phase4.yml up -d redis
docker build -f apps/worker/docker/Dockerfile -t performance-k6:1.8.2-phase5 .
npm run build
```

Start the API and worker in separate terminals:

```sh
npm run start:dev
```

```sh
npm run start:worker
```

Optionally start the UI in another terminal with `npm run start:web`, then open
`http://127.0.0.1:5173`. The worker checks the hardened image before claiming
runs and uses its immutable image ID for execution. The image pins Grafana k6
v1.8.2, a security-maintenance release; CI smoke-tests the worker's CLI options
and generated runtime option shape before scanning the image. A plain
`grafana/k6` image does not contain this profile's firewall entrypoint and will
be rejected.

The Redis compose file binds to loopback and enables append-only persistence.
PostgreSQL remains the source of truth; queue loss does not authorize rerunning
a previously started test. Do not expose this local Redis configuration publicly.

### One-time review upgrade

Migration `004_phase_4_run_orchestration.sql` preserves old review history and
adds the stored review checksum. Reviews made before this migration must be
recorded again. Use `GET /plans/{planId}` to obtain the actual script checksum,
then the Phase 3 review endpoint:

```http
POST {{baseUrl}}/plans/{{planId}}/versions/{{planVersion}}/review
```

```json
{ "reviewed": true, "sha256": "{{scriptSha256}}" }
```

Expected **201**, `script.reviewStatus: "reviewed"`. A new edit requires a new
review. Runs cannot change the target or workload of a reviewed version.

## Postman setup

Start with [local Postman setup and real IDs](./postman-get-started.md)
if you do not already have a reviewed plan. The collection's **00 Setup**
folder lists existing projects/plans and fills the current version's variables.
`runId` remains empty until an approval response returns it.

Import [phase-4.postman_collection.json](./phase-4.postman_collection.json).
Select **No Auth**. The API supplies the fixed local user; no token is required.

| Collection variable | Value |
|---|---|
| `baseUrl` | `http://127.0.0.1:3000/api/v1` |
| `planId` | Accessible Phase 3 plan UUID |
| `planVersion` | A reviewed version number |
| `targetId` | That version's registered target UUID |
| `virtualUsers` | Exactly the reviewed version's VUs; example `1` |
| `durationSeconds` | Exactly the reviewed duration; example `10` |

The collection captures `runId` and generates an `idempotencyKey`. JSON POST requests
use `Content-Type: application/json`. Only approve targets you are authorized
to load test. No implementation check in this workspace sends load to a public
target; local tests use an isolated database and mocked runtime.

## 1. Read the run policy

`GET {{baseUrl}}/plans/{{planId}}/run-policy` — no body.

Expected **200 OK**:

```json
{
  "maxVirtualUsers": 10,
  "maxDurationSeconds": 60,
  "maxConcurrentRuns": 5,
  "maxRequestsPerSecond": 2,
  "maxRequestsPerRun": 20
}
```

These are illustrative configured values, not defaults. Actual output reflects
your `.env`. Missing/invalid limits return **503 `run_policy_not_configured`**.

## 2. Approve and queue a run

```http
POST {{baseUrl}}/plans/{{planId}}/runs
Idempotency-Key: {{idempotencyKey}}
Content-Type: application/json
```

```json
{
  "targetId": "{{targetId}}",
  "planVersion": 1,
  "workload": { "virtualUsers": 1, "durationSeconds": 10 },
  "authorizationConfirmed": true,
  "approved": true
}
```

Use your actual reviewed version and workload. Generate a UUID for
`idempotencyKey`, then preserve it when retrying this same approval request.

Expected **202 Accepted**:

```json
{
  "runId": "81e06199-fefc-49ae-aad4-0c73d65355e9",
  "projectId": "6b7f8669-71c1-4bba-96dd-ef1e471442ae",
  "planVersionId": "3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00",
  "targetId": "6fe497c5-63ad-408a-a538-46530a32c05a",
  "status": "queued",
  "createdAt": "2026-10-25T12:15:00.000Z",
  "authorizationConfirmedAt": "2026-10-25T12:15:00.000Z",
  "approvedAt": "2026-10-25T12:15:00.000Z",
  "queuedAt": "2026-10-25T12:15:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failureCode": null,
  "workload": { "virtualUsers": 1, "durationSeconds": 10 },
  "limits": {
    "maxVirtualUsers": 10,
    "maxDurationSeconds": 60,
    "maxConcurrentRuns": 5,
    "maxRequestsPerSecond": 2,
    "maxRequestsPerRun": 20
  },
  "scriptSha256": "<actual reviewed script checksum>",
  "statusUrl": "/api/v1/runs/81e06199-fefc-49ae-aad4-0c73d65355e9",
  "summary": null
}
```

IDs, timestamps, limits, and checksum vary. The run and outbox are committed in
one transaction before publication. A temporary Redis outage therefore does
not discard an approved run; it stays queued until dispatch recovers.

Repeat the same request with the same key: expected **202**, the **same run ID**
and its current status. No extra run is created. Reuse that key with a changed
request: **409 Conflict**. A deliberate new test requires a new key.

## 3. Read status

`GET {{baseUrl}}/runs/{{runId}}` — no body.

Expected **200 OK**, the same response fields, with lifecycle timestamps and
one of these states:

```text
queued → running → completed
                → failed
queued → cancelled
running → cancelling → cancelled
```

`completed` means the k6 process exited successfully; it does not establish SLA
success or threshold status. Results/metrics/reports are Phase 5. A normal
completion has `failureCode: null`, populated `startedAt`/`completedAt`, and
`summary: null`. Infrastructure/policy failures use a short `failureCode`; raw
worker logs and credentials are never included.

The trusted runtime imports the unchanged reviewed script, then supplies
`shared-iterations`, duration, `gracefulStop: 0s`, and one-process RPS ceilings.
The total iteration budget is `floor(maxRequestsPerRun / scenarioCount)`, so
the test may finish early when that budget is consumed. HTTP redirects are
never followed. These are generated HTTP-request ceilings; TCP/TLS handshakes
are not counted as HTTP requests.

## 4. Request cancellation

`POST {{baseUrl}}/runs/{{runId}}/cancel` — no body required.

Expected **202 Accepted**, the same run response shape:

- Queued run: `status: "cancelled"`, populated `completedAt`; it never executes.
- Running run: `status: "cancelling"`; polling eventually reports `cancelled`
  once the worker has stopped the container.
- Terminal run: its existing terminal state is returned unchanged.

Cancellation is idempotent and audited. A run can finish just before the request
arrives; cancellation then returns its completed/failed state.

## Rejection tests

| Request | Expected |
|---|---|
| Disabled fixed-user account | 403 |
| Missing/malformed `Idempotency-Key` UUID | 400 |
| Missing or false `approved`/`authorizationConfirmed` | 400 |
| Unknown workload fields, strings instead of integers | 400 |
| Unreviewed script or old timestamp-only review | 409 `script_review_required` |
| Workload/target differs from reviewed version | 409 |
| Inaccessible plan, target, run, or deleted project | 404 |
| Required ceiling absent/invalid or concurrency above five | 503 |
| Configured ceilings reject the reviewed workload | 400 `workload_policy_violation` |
| All admission slots reserved | 429 `run_capacity_exceeded` |
| Same key with a changed body | 409 |

Stop the worker before testing queued cancellation/recovery if you need a
reproducible queued state. Never test queue saturation by repeatedly approving
unintended live load. Queued approvals can be cancelled without executing them.

## Recovery and operational limits

- The outbox retries still-queued delivery after ten seconds. BullMQ deduplicates
  by run UUID; PostgreSQL atomically permits only one execution claim.
- Queue jobs have one execution attempt, with stalled-job retries disabled.
  Started runs are never automatically retried because that would create load.
- Heartbeats and cancellation checks run every 500 ms. Thirty-second stale
  heartbeats or the execution deadline allow the host's recovery loop to fence
  the old worker, remove its container, and mark it failed/cancelled.
- The execution token is checked again after container creation and before its
  start. A paused worker cannot start a late container after recovery has fenced
  its run. Target disablement and access revocation are checked by heartbeats.
- A stopped worker's container has an independent watchdog. If Docker cannot
  confirm removal, the run stays nonterminal and reserves capacity until the
  host returns. Other hosts cannot safely reclaim that host's containers.
- The Docker image's root setup capabilities are removed before k6 executes.
  The container has a read-only filesystem and script bind mount, no control-plane
  credentials or Docker socket, and no automatic restart.
- A host crash may leave temporary script directories under its temp directory.
  Clean those only after confirming their containers have stopped.

References: [k6 execution options](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/),
[k6 pinned release](https://github.com/grafana/k6/releases/tag/v1.8.2),
[BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids),
[BullMQ stalled jobs](https://docs.bullmq.io/guide/jobs/stalled),
[Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

## Verification status

Automated checks cover the migrations and real PostgreSQL SQL using PGlite,
token-free HTTP validation and project isolation, idempotency, outbox failure/reconciliation,
duplicate delivery, cancellation, execution fencing, DNS/IP validation, and
container argument policies. PGlite serializes connections; it does not replace
multi-instance PostgreSQL concurrency testing. Redis publication and Docker/k6
execution are mocked in integration tests. This workspace has no Docker daemon,
so the hardened image and real Redis/k6 lifecycle still need local verification
with the setup and Postman requests above.

Phase 5 was subsequently approved. Follow its guide for results, reports and
manual deletion verification. Phase 6 remains gated on explicit user approval.
