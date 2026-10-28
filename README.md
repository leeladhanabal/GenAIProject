# AI Performance Testing Agent

Backend and plan-review/run UI with local Phase 5 results and lifecycle features.
It uses a fixed local mock user, PostgreSQL persistence, tenant-scoped projects and targets,
public target URL validation, audit events, immutable plan versions, OpenAPI
operation import, Groq-assisted scenario generation, constrained k6 script editing,
review, and downloads. Provider tests use mocked responses; live generation
requires your Groq API key and Postman verification. Phase 4 adds durable run
approval, Redis/BullMQ delivery, isolated Docker k6 execution, cancellation, and
recovery. Phase 5 adds measured summaries, JSON/HTML reports, private local
artifacts, exports, in-app notices, and explicit project deletion. Cloud Storage
integration remains pending. The approved local policy uses manual deletion,
a 2-day notice lead time, and in-app notices; email and automatic deletion are disabled.

## Requirements

- Node.js 20.19+ or 22.12+ (or a newer supported major)
- npm
- PostgreSQL

## Run the backend

```powershell
npm install
npm run db:migrate
npm run start:dev
```

Before starting, copy `.env.example` to `.env`, configure `DATABASE_URL`, and
set `AUTH_MODE=local-mock` and `NODE_ENV=development`. Existing `.env` secrets
are preserved. The API binds to `127.0.0.1:3000`; set `PORT` to change its port.
No login, token, or OAuth client ID is required. Local mock mode is rejected
outside development/test environments.

The fixed identity is `local-mock` / `local-test-user`, displayed as
**Local Test User** (`local-test@example.test`). The first user-aware API call
upserts its persistent database user. Existing project membership is still
enforced; data owned by previous identities is not automatically reassigned.
See [the token-free Postman setup](docs/postman-get-started.md).

## Phase 1 Postman smoke test

**Method:** `GET`

**URL:** `http://127.0.0.1:3000/api/v1/health`

**Headers:** none
**Request body:** none

Expected response: `200 OK`

```json
{
  "status": "ok",
  "service": "ai-performance-agent-api",
  "timestamp": "2026-10-24T10:15:00.000Z"
}
```

`timestamp` is the current UTC time in ISO 8601 format.

## Phase 2 Postman tests

Follow [docs/phase-2-postman.md](docs/phase-2-postman.md) to configure the fixed
local user and PostgreSQL, then test project and authorized-target
endpoints. Only register targets you own or are explicitly authorized to test.

## Phase 3 plan APIs

Apply migrations with `npm run db:migrate`, then follow
[docs/phase-3-plans.md](docs/phase-3-plans.md) to create and version plans.
Configure approved `MAX_VIRTUAL_USERS` and `MAX_DURATION_SECONDS` in `.env`
before saving scripts. Set `GROQ_API_KEY` locally in `.env`; the initial
`GROQ_MODEL` is `llama-3.3-70b-versatile` and `GROQ_TIMEOUT_MS` is `30000`.
Import [the Postman collection](docs/phase-3.postman_collection.json) for the
create/generate/version/review/download sequence. Without the key or model,
generation returns `503 ai_provider_not_configured`. Only saved requirements
and normalized operation methods/paths are sent to Groq.

Run `npm run start:web` in another terminal and open `http://127.0.0.1:5173`
for the React editing/review UI. Enter a project ID belonging to the fixed local
user. Vite proxies `/api` to port 3000 locally.
The web build is written to `dist-web`; hosting belongs to a later phase.

## Phase 5 Postman tests

Follow [the Phase 5 setup and endpoint examples](docs/phase-5-results.md).
After migrating and building, run `npm run phase5:seed` to obtain real fixture
project/plan/run IDs without running load. Start `npm run start:phase5` alongside
the API, then import [the Phase 5 collection](docs/phase-5.postman_collection.json).
Use No Auth. [Explicit deletion has a separate collection](docs/phase-5-deletion.postman_collection.json)
that is disabled by default. Save your export before confirming deletion.
Phase 6 is approved for initial release-readiness work. Cloud Run API with GKE
Standard workers is the selected design direction for evaluation only; the
operations owner remains undecided, and no cloud resources are provisioned.
See [the Phase 6 cloud decision](docs/phase-6-cloud-decision.md) and
[local release-readiness runbook](docs/runbooks/phase-6-release-readiness.md).

## Verify locally

For Phase 4 setup, one-time script re-review, worker startup, endpoint bodies,
expected responses, and runtime verification limits, follow
[docs/phase-4-runs.md](docs/phase-4-runs.md). Import the
[Phase 4 Postman collection](docs/phase-4.postman_collection.json).
Set approved `MAX_REQUESTS_PER_SECOND` and `MAX_REQUESTS_PER_RUN` before
approving tests. Start Redis, build the hardened worker image, run
`npm run build`, then start `npm run start:worker` separately from the API.
Only approve load on targets you are authorized to test.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

See [docs/phase-1-foundation.md](docs/phase-1-foundation.md) for the Phase 1
threat-model boundaries.
