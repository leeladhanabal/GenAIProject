# Phase 2 — Postman and local setup

Phase 2 uses the fixed local mock user, PostgreSQL-backed
users/projects/targets/audit events, project access isolation, and public-target
URL checks. It does not implement plan generation, load-test execution, or any
later-phase endpoint.

## Local prerequisites

1. Install PostgreSQL locally and start its service on port `5432`. Use the
   password you set for the local `postgres` role.
2. Create a database named `ai_performance_agent`. From PowerShell, connect with:

   ```powershell
   & 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -U postgres -h localhost -d postgres
   ```

   Enter the local `postgres` password when prompted, then run
   `CREATE DATABASE ai_performance_agent;` at the `psql` prompt and enter `\q`.
3. Copy `.env.example` to `.env`, then set:
   - `DATABASE_URL` to the local PostgreSQL connection string. Keep the password
     in this ignored `.env` file; do not commit it or send it in chat.
   - `AUTH_MODE=local-mock` and `NODE_ENV=development` for local testing.
4. Run the database migration and API:

   ```powershell
   npm install
   npm run db:migrate
   npm run start:dev
   ```

After editing `.env`, restart the API. It listens only on `127.0.0.1`, port
`3000` by default. The health endpoint is `GET http://127.0.0.1:3000/api/v1/health`.

## Use the fixed local user in Postman

Set the collection/request Authorization tab to **No Auth**. No token, login,
or Google client configuration is required. Use `Content-Type: application/json`
on POSTs with JSON bodies.

Every request uses this server-defined identity:

```json
{
  "issuer": "local-mock",
  "subject": "local-test-user",
  "email": "local-test@example.test",
  "displayName": "Local Test User"
}
```

The existing user upsert creates a persistent UUID for this issuer/subject on
first use. Project membership and disabled-account checks still apply. Headers
and request bodies cannot switch the user. Existing projects owned by previous
identities need explicit membership for this user or fresh local test data.
This mode is enabled only with `AUTH_MODE=local-mock` and `NODE_ENV=development`
or `test`; API startup rejects other configurations, including production.

## Phase 2 endpoints

### Create a project

```http
POST http://127.0.0.1:3000/api/v1/projects
Content-Type: application/json
```

Request:

```json
{
  "name": "Staging performance tests"
}
```

Expected: `201 Created`

```json
{
  "id": "8dc50d11-b8ec-49f4-8532-5e74627ae440",
  "name": "Staging performance tests",
  "createdAt": "2026-10-24T12:15:00.000Z"
}
```

Save the returned `id` as `projectId` in Postman.

### List accessible projects

```http
GET http://127.0.0.1:3000/api/v1/projects
```

Expected: `200 OK`. The local user receives an empty `items` array
until they create a project.

```json
{
  "items": [
    {
      "id": "8dc50d11-b8ec-49f4-8532-5e74627ae440",
      "name": "Staging performance tests",
      "createdAt": "2026-10-24T12:15:00.000Z",
      "updatedAt": "2026-10-24T12:15:00.000Z"
    }
  ]
}
```

### Register an authorized target

Only register a domain you own or are explicitly authorized to test. The target
must use HTTPS, match an approved domain, resolve to public IP addresses, and
not include credentials, a custom port, query string, or fragment. Private,
loopback, link-local, metadata, and reserved IP destinations are rejected.

```http
POST http://127.0.0.1:3000/api/v1/projects/{{projectId}}/targets
Content-Type: application/json
```

Request:

```json
{
  "name": "Authorized staging API",
  "baseUrl": "https://staging.your-owned-domain.example",
  "approvedDomains": ["your-owned-domain.example"],
  "authorizationConfirmed": true
}
```

Use a real domain you are authorized to register; the example hostname is
illustrative and will not resolve.

Expected: `201 Created`

```json
{
  "id": "3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00",
  "name": "Authorized staging API",
  "status": "active",
  "baseUrl": "https://staging.your-owned-domain.example/",
  "approvedDomains": ["your-owned-domain.example"],
  "createdAt": "2026-10-24T12:20:00.000Z"
}
```

### List targets for a project

```http
GET http://127.0.0.1:3000/api/v1/projects/{{projectId}}/targets
```

Expected: `200 OK`

```json
{
  "items": [
    {
      "id": "3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00",
      "name": "Authorized staging API",
      "status": "active",
      "baseUrl": "https://staging.your-owned-domain.example/",
      "approvedDomains": ["your-owned-domain.example"],
      "authorizationConfirmedAt": "2026-10-24T12:20:00.000Z",
      "createdAt": "2026-10-24T12:20:00.000Z"
    }
  ]
}
```

## Error response examples

All API errors have the architecture's stable shape. `requestId` also appears
in the `X-Request-Id` response header.

A disabled local account returns `403 Forbidden`. Missing an Authorization
header is valid in local mock mode.

Invalid target policy: `400 Bad Request`

```json
{
  "error": {
    "code": "target_policy_violation",
    "message": "baseUrl must use HTTPS",
    "requestId": "c2bff7c8-5d6e-40b4-8f20-154b646a79e1",
    "details": null
  }
}
```

Project not owned or accessible to this user: `404 Not Found`.
