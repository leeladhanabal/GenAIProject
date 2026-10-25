# Phase 3 — Plan management

The API supports manually authored plan requirements and immutable versions.
Each update creates a new version; previous versions remain available for
reproducibility. This phase does not call an AI provider, accept uploaded
specifications, create k6 scripts, or launch tests. Workload limits and AI
provider/data-use decisions remain unresolved, so a stored plan is not runnable.

Apply pending migrations before starting the API:

```powershell
npm run db:migrate
npm run start:dev
```

All endpoints below require a Google ID token bearer credential configured as
described in [Phase 2 setup](./phase-2-postman.md).

## Create a plan

```http
POST http://localhost:3000/api/v1/projects/{{projectId}}/plans
Content-Type: application/json
```

```json
{
  "name": "Checkout performance plan",
  "requirementsText": "Measure the checkout flow for the staging application."
}
```

Expected: `201 Created`. Creation stores version 1 with an empty workload
snapshot because workload policy limits have not been configured.

```json
{
  "id": "8dc50d11-b8ec-49f4-8532-5e74627ae440",
  "projectId": "6b7f8669-71c1-4bba-96dd-ef1e471442ae",
  "name": "Checkout performance plan",
  "sourceType": "manual",
  "status": "draft",
  "currentVersion": 1,
  "createdAt": "2026-10-25T12:15:00.000Z",
  "updatedAt": "2026-10-25T12:15:00.000Z",
  "versions": [
    {
      "id": "3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00",
      "version": 1,
      "requirementsText": "Measure the checkout flow for the staging application.",
      "workload": {},
      "createdAt": "2026-10-25T12:15:00.000Z"
    }
  ]
}
```

## List project plans

```http
GET http://localhost:3000/api/v1/projects/{{projectId}}/plans
```

Expected: `200 OK`, with plan metadata and each plan's latest version number in
`currentVersion`. A project with no plans returns an empty `items` array.

## Read a plan and its versions

```http
GET http://localhost:3000/api/v1/plans/{{planId}}
```

Expected: `200 OK`, with the plan metadata and all immutable versions ordered
from oldest to newest. A plan outside the user's project access returns
`404 Not Found`.

## Create a new version

```http
POST http://localhost:3000/api/v1/plans/{{planId}}/versions
Content-Type: application/json
```

```json
{
  "requirementsText": "Measure checkout and record the confirmation step."
}
```

Expected: `201 Created`. The API increments the version while holding a
transactional row lock, preserves the prior workload snapshot, updates the
plan timestamp, and writes an audit event.
