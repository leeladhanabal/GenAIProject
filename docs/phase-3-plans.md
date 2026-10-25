# Phase 3 — Planning and script generation: Postman guide

Scope follows **Section 32, Phase 3** of `Architecture.md`. Section 3 is the
problem statement. Phase 4 run APIs are documented separately in
[phase-4-runs.md](./phase-4-runs.md).

Implemented: immutable plan versions, OpenAPI operation import, an AI adapter
interface with a Groq implementation, constrained k6 script compilation/validation, script editing through
new versions, checksum-bound human review, authenticated downloads, and a React
editing/review UI. Groq is the selected AI provider, with the initial model
`llama-3.3-70b-versatile`. Generation uses the real Groq API when configured.
Tests mock provider responses; live generation still needs your key and Postman
verification. No mock provider is available in the running application.

## Setup

Use the PostgreSQL database, fixed local user, project, and approved target
from [Phase 2](./phase-2-postman.md). Keep credentials out of plan content.

```sh
npm install
npm run db:migrate
npm run start:dev
```

Migration `003_phase_3_planning_content.sql` adds specification/script metadata,
review metadata, and scenarios. Existing versions remain readable. Before saving
scripts, set `MAX_VIRTUAL_USERS` and `MAX_DURATION_SECONDS` in `.env` to approved
positive integer ceilings and restart the API. There are no default ceilings.
Examples below use a **draft of 1 VU for 10 seconds**; your ceilings must allow
those values. No API in this phase executes a script or starts a run.

Set the Groq settings in your ignored `.env` file, then restart the API:

```dotenv
GROQ_API_KEY=your-real-key-here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_MS=30000
```

Groq is the provider; `GROQ_MODEL` selects the model hosted by Groq. The initial
model is listed in [Groq's supported models](https://console.groq.com/docs/models).
Use a model available to your account that supports JSON object mode. The adapter
uses [Groq chat completions](https://console.groq.com/docs/api-reference), a shared
request deadline, and up to three attempts with bounded exponential backoff for
transient failures. Invalid outputs and authentication failures are not retried.

Import [phase-3.postman_collection.json](./phase-3.postman_collection.json).
Set collection variables `baseUrl = http://127.0.0.1:3000/api/v1`,
`projectId`, and `targetId`. Use a target registered in the same project.
Select **No Auth**; no token is required. POSTs use
`Content-Type: application/json`. The collection captures `planId`,
`planVersion`, and `scriptSha256` from actual responses. IDs/timestamps in this
guide are illustrative; never substitute an invented checksum.

## 1. Create a plan

`POST {{baseUrl}}/projects/{{projectId}}/plans`

```json
{
  "name": "Health API performance plan",
  "requirementsText": "Check staging health and require HTTP 200.",
  "specification": {
    "openapi": "3.0.3",
    "info": { "title": "Staging API", "version": "1.0.0" },
    "paths": {
      "/health": {
        "get": { "responses": { "200": { "description": "Healthy" } } }
      }
    }
  }
}
```

Expected **201 Created**. Save `id` as `planId`. Omit `specification` for a
requirements-only plan (`sourceType: "manual"`, `specification: null`).

```json
{
  "id": "8dc50d11-b8ec-49f4-8532-5e74627ae440",
  "projectId": "6b7f8669-71c1-4bba-96dd-ef1e471442ae",
  "name": "Health API performance plan",
  "sourceType": "openapi",
  "status": "draft",
  "currentVersion": 1,
  "createdAt": "2026-10-25T12:15:00.000Z",
  "updatedAt": "2026-10-25T12:15:00.000Z",
  "versions": [{
    "id": "3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00",
    "version": 1,
    "requirementsText": "Check staging health and require HTTP 200.",
    "workload": {},
    "createdAt": "2026-10-25T12:15:00.000Z",
    "specification": {
      "openapi": "3.0.3",
      "operations": [{ "method": "GET", "path": "/health" }]
    },
    "script": null
  }]
}
```

Input is OpenAPI 3.0/3.1 **JSON**, under 100 KB, containing 1–100 operations.
Only operation methods and relative paths are retained. Server URLs,
descriptions, examples, schemas, and credentials are discarded; references are
never fetched. This is an operation importer, not a full OpenAPI conformance
validator. The HTTP JSON limit also applies to the entire request.

## 2. List and read plans

`GET {{baseUrl}}/projects/{{projectId}}/plans` — no body.

Expected **200 OK**, `{ "items": [...] }`. Items contain plan metadata and
`currentVersion`, without the `versions` array.

`GET {{baseUrl}}/plans/{{planId}}` — no body.

Expected **200 OK**, the creation response shape with all versions ordered
oldest first. Previous content remains unchanged after edits. Inaccessible
projects/plans return **404**.

## 3. Save a script in a new version

`POST {{baseUrl}}/plans/{{planId}}/versions`

```json
{
  "expectedVersion": 1,
  "requirementsText": "Check staging health and require HTTP 200.",
  "script": {
    "targetId": "{{targetId}}",
    "workload": { "virtualUsers": 1, "durationSeconds": 10 },
    "scenarios": [{
      "name": "Health responds successfully",
      "method": "GET",
      "path": "/health",
      "expectedStatus": 200
    }]
  }
}
```

Expected **201 Created**, plan metadata with `currentVersion: 2` and a singular
`version` object. That version contains requirements, workload, retained
specification, and a `script` object with:

| Response field | Expected value |
|---|---|
| `version.script.content` | Complete compiled k6 JavaScript for review |
| `version.script.sha256` | 64 lowercase hexadecimal characters |
| `version.script.definition` | Submitted script definition plus registered `baseUrl` |
| `version.script.validationStatus` | `valid` |
| `version.script.reviewStatus` | `pending` |
| `version.script.reviewedAt` | `null` |

Save `version.script.sha256` as `scriptSha256` and `currentVersion` as
`planVersion`. Review the actual script, destination, and workload.

Scripts compile from structured definitions; arbitrary JavaScript is rejected.
Supported methods are GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. The initial
editor supports literal paths without query strings, custom headers, or request
bodies. Replace path parameters with explicit synthetic values. `/health` is
appended beneath the registered target base path. Compilation makes no target
requests. Every compiled request disables redirects.

To edit, POST another version with an updated `script` and the current
`expectedVersion`. Every new script starts `pending`, including edits of a
reviewed script. Omit `script` for a requirements-only version; no previous
script/review is copied. Omitted specifications carry forward. A stale
`expectedVersion` returns **409** without saving a version.

## 4. Check the review requirement

`GET {{baseUrl}}/plans/{{planId}}/versions/{{planVersion}}/script` — no body.

Before review, expected **409 Conflict**:

```json
{
  "error": {
    "code": "conflict",
    "message": "Review this script before downloading",
    "requestId": "...request UUID...",
    "details": null
  }
}
```

## 5. Record review

`POST {{baseUrl}}/plans/{{planId}}/versions/{{planVersion}}/review`

```json
{
  "reviewed": true,
  "sha256": "{{scriptSha256}}"
}
```

Expected **201 Created**, the version object with `script.reviewStatus:
"reviewed"`, a populated `script.reviewedAt`, and the same checksum.
A different checksum returns **409**; `reviewed: false` returns **400**.
Review is audited. Script review does not approve a run.

## 6. Download

`GET {{baseUrl}}/plans/{{planId}}/versions/{{planVersion}}/script` — no body.

Expected **200 OK**, JavaScript text, not JSON. Headers include
`Content-Type: application/javascript; charset=utf-8`, an attachment filename,
and `X-Script-SHA256` matching the reviewed checksum. Use **Send and Download**.
Example content (the URL comes from your actual registered target):

```javascript
// Review this script and obtain explicit run approval before execution.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  "vus": 1,
  "duration": "10s",
  "maxRedirects": 0
};

export default function () {
  {
    const response = http.request("GET", "https://your-registered-target/health", null, { redirects: 0 });
    check(response, { ["Health responds successfully"]: (r) => r.status === 200 });
  }
  sleep(1);
}
```

Execution-time DNS validation, networking/resource controls, and explicit run
approval belong to Phase 4. Phase 3 endpoints alone do not start runs. After
upgrading to Phase 4, record script review again to store the reviewed checksum
required for execution; old review timestamps are retained as history.

## 7. Generate scenarios and a script with Groq

`POST {{baseUrl}}/plans/{{planId}}/generate`

```json
{
  "version": 2,
  "targetId": "{{targetId}}",
  "workload": { "virtualUsers": 1, "durationSeconds": 10 }
}
```

Use the actual current version. With a valid key/model, accessible target,
and configured workload ceilings, expected **201 Created**. The response is
the same plan metadata plus singular `version` shape as the version-creation
endpoint. For a current version of 2:

| Response field | Expected |
|---|---|
| `currentVersion` | `3` |
| `version.version` | `3` |
| `version.script.validationStatus` | `valid` |
| `version.script.reviewStatus` | `pending` |
| `version.script.reviewedAt` | `null` |
| `version.script.content` | Compiled k6 script from validated Groq scenario data |
| `version.script.sha256` | Checksum of the actual returned script |

Scenario labels and output vary; do not expect a fixed AI response or checksum.
The original version is preserved. Generation is synchronous and does not
launch a load test. Review the returned script using steps 5–6, with the **new**
version number and checksum. A new version resets script review.

Without `GROQ_API_KEY` or `GROQ_MODEL`, expected **503 Service Unavailable**:

```json
{
  "error": {
    "code": "ai_provider_not_configured",
    "message": "Set GROQ_API_KEY and GROQ_MODEL in .env, then restart the API. No data was sent.",
    "requestId": "...request UUID...",
    "details": null
  }
}
```

No version is saved on provider failure. Other provider errors:

| HTTP status | Error code | Meaning |
|---|---|---|
| 503 | `ai_provider_authentication_failed` | Invalid key or denied model access |
| 503 | `ai_provider_rate_limited` | Groq rate limit after bounded retries |
| 503 | `ai_provider_unavailable` | Network or provider service failure |
| 504 | `ai_provider_timeout` | Shared request deadline exceeded |
| 502 | `ai_provider_request_failed` | Model/request rejected by Groq |
| 502 | `ai_output_invalid` | Invalid, incomplete, or unsupported scenario output |

The provider receives only the selected saved version's `requirementsText` and
normalized specification (`openapi`, operation methods/paths). Identity, bearer
tokens, project/target IDs, target URLs, and workload configuration are not sent.
Do not place secrets in requirements or operation paths. Groq returns scenario
data, never executable code. All returned scenarios pass the existing local
validation and require human script review.

Provider-side retention is controlled by your Groq account, not `.env`.
Review [Groq's data controls](https://console.groq.com/docs/your-data) for your
organization's production data policy; this application makes no claim that
zero data retention is enabled on your account.

## Rejection tests

| Test | Expected |
|---|---|
| Disabled fixed-user account | 403 |
| Invalid UUID, blank requirements, unknown DTO property | 400 |
| Invalid, unsupported, or oversized specification | 400 |
| Script path `//evil.example`, encoded traversal, unresolved `{id}`, query string | 400 `planning_input_invalid` |
| Raw JavaScript or unexpected script/scenario options | 400 `planning_input_invalid` |
| Workload exceeds a configured ceiling | 400 `workload_policy_violation` |
| Missing workload ceilings | 503 `workload_policy_not_configured` |
| Another user's project/plan or target in a different project | 404 |
| Stale `expectedVersion` | 409 |
| Missing script, unreviewed download, mismatched review checksum | 409 |
| New version of a reviewed script | New script is `pending`; old version unchanged |

## UI and verification

Run `npm run start:web` in another terminal and open `http://127.0.0.1:5173`.
Enter a project ID belonging to the fixed local user. There is no token field.
The UI lists/creates plans, imports specs, edits structured script definitions,
previews saved versions, records review, and downloads reviewed scripts.
It also generates scenarios/scripts through Groq from the selected current
saved version; unsaved editor changes are not sent.

Local checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
Database SQL/repositories still require validation with your real PostgreSQL
setup and Postman credentials; mocked tests do not establish live integration.
