# Local Postman setup: fixed user, plan ID, and run ID

Use **No Auth** for all application API requests. No token, Google login, client
ID, or client secret is required. The API always supplies **Local Test User**
(`local-test@example.test`) with issuer `local-mock` and subject `local-test-user`.
Client-supplied identity headers are ignored.

## 1. Configure and start the local API

In the ignored `.env` file, configure your real PostgreSQL connection and:

```dotenv
AUTH_MODE=local-mock
NODE_ENV=development
```

Then run:

```sh
npm install
npm run db:migrate
npm run start:dev
```

Restart an already-running API to pick up these changes. The API binds to
`127.0.0.1:3000` by default. Startup rejects local mock authentication outside
development/test environments. Groq and workload settings are documented in
the [Phase 3](./phase-3-plans.md) and [Phase 4](./phase-4-runs.md) guides.

The first user-aware request upserts the fixed user's persistent database UUID.
Project ownership/membership and disabled-account checks remain in effect.
Existing data owned by another identity is not reassigned automatically; create
local test data or explicitly grant membership through your database setup.
The identity fields reuse the existing user schema; no new migration is needed
for this authentication change. Plan/run UUIDs are still created by normal APIs.

## 2. Create a project or find an existing one

Re-import the updated [Phase 4 collection](./phase-4.postman_collection.json),
set its Authorization to **No Auth**, and set `baseUrl` to
`http://127.0.0.1:3000/api/v1`. There is no `idToken` variable.

Open **00 Setup — obtain real project and plan IDs** and send requests
individually:

| Request | Response value |
|---|---|
| `GET {{baseUrl}}/projects` | Choose `items[].id` as `projectId` |
| `GET {{baseUrl}}/projects/{{projectId}}/plans` | Choose `items[].id` as `planId` |
| `GET {{baseUrl}}/plans/{{planId}}` | Read the current version and saved script |

Each expects **200 OK**. When exactly one project/plan exists, the collection
saves its ID automatically. With several, select the intended ID in collection
variables. The final setup request fills `planVersion`, `targetId`,
`virtualUsers`, `durationSeconds`, and `scriptSha256` from the actual saved version.

If `GET /projects` returns `{ "items": [] }`, create your first project:

```http
POST {{baseUrl}}/projects
Content-Type: application/json
```

```json
{ "name": "Local performance tests" }
```

Expected **201 Created**, with `id`, `name`, and `createdAt`. Save `id` as
`projectId`. Use the [Phase 2 target requests](./phase-2-postman.md) to register
a target you are authorized to test, then the
[Phase 3 plan/script requests](./phase-3-plans.md) to create a plan. The returned
plan `id` is your `planId`. Example UUIDs in documentation are not seeded data.

## 3. Review the script

If setup reports a pending script, inspect its saved content, destination, and
workload. Then explicitly record review:

```http
POST {{baseUrl}}/plans/{{planId}}/versions/{{planVersion}}/review
Content-Type: application/json
```

```json
{ "reviewed": true, "sha256": "{{scriptSha256}}" }
```

Expected **201 Created**, with `script.reviewStatus: "reviewed"`. Re-run setup
request C afterward. Earlier timestamp-only reviews must be recorded again
after the Phase 4 migration. Setup requests never record review or approve runs.

## 4. Obtain the run ID

Leave `runId` empty initially. Configure the approved request ceilings, Redis,
and Docker worker using the [Phase 4 guide](./phase-4-runs.md). When you intend
to start an authorized test, send **02 Approve and queue a run**.

Expected **202 Accepted**, with `runId` and `status: "queued"`. The collection
automatically saves `runId` for status and cancellation requests. Script review,
target authorization confirmation, explicit run approval, and the UUID
`Idempotency-Key` remain required.

Use **03 Retry same approval key** to retry that approval without creating a
second run. Request 02 generates a new key each time, so sending it again
deliberately requests another run.
