# AI Performance Testing Agent

Backend foundation for the architecture's Phase 1 and Phase 2. Phase 2 adds
Google OIDC bearer authentication, PostgreSQL persistence, tenant-scoped
projects and targets, public target URL validation, and audit events. Plan
generation and load-test execution are not implemented.

## Requirements

- Node.js 20 or newer
- npm
- PostgreSQL

## Run the backend

```powershell
npm install
npm run db:migrate
npm run start:dev
```

Before starting, copy `.env.example` to `.env` and configure `DATABASE_URL` and
`GOOGLE_CLIENT_ID`. The API listens on port `3000` by default. Set `PORT` to
override it.

## Phase 1 Postman smoke test

**Method:** `GET`

**URL:** `http://localhost:3000/api/v1/health`

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

Follow [docs/phase-2-postman.md](docs/phase-2-postman.md) to configure Google
OIDC authentication and PostgreSQL, then test project and authorized-target
endpoints. Only register targets you own or are explicitly authorized to test.

## Verify locally

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

See [docs/phase-1-foundation.md](docs/phase-1-foundation.md) for the Phase 1
threat-model boundaries.