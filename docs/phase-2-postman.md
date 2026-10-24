# Phase 2 — Postman and local setup

Phase 2 implements Google OIDC bearer-token authentication, PostgreSQL-backed
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
   - `GOOGLE_CLIENT_ID` to the OAuth 2.0 client ID described below.
4. In Google Cloud Console, create an OAuth 2.0 client with the Postman callback
   URL `https://oauth.pstmn.io/v1/callback`. Configure the consent screen and,
   while the app is in testing mode, add the Google account you will use as a
   test user. Keep the OAuth client secret in Postman's local authorization
   settings; the API only needs the client ID.
5. Run the database migration and API:

   ```powershell
   npm install
   npm run db:migrate
   npm run start:dev
   ```

If the API was already running while `.env` was edited, stop it and start it
again so the process loads the Google client ID and database connection.

The health check remains available at `GET http://localhost:3000/api/v1/health`
without authentication.

## Get a Google ID token in Postman

For each authenticated request, set Authorization to **OAuth 2.0** and request
a token using:

- Grant type: Authorization Code (with PKCE)
- Callback URL: `https://oauth.pstmn.io/v1/callback`
- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Access Token URL: `https://oauth2.googleapis.com/token`
- Client ID: the same value as `GOOGLE_CLIENT_ID`
- Client Secret: the secret for the Google OAuth client (keep it in Postman,
  not in the API `.env` or source control)
- Scope: `openid email profile`
- Client authentication: send client credentials in the request body if the
  Google client flow requires a secret

After Postman obtains the token, use the **Google `id_token`** from the token
response as the HTTP bearer credential. Do not use the OAuth access token for
these API endpoints. If Postman only exposes the access token in its OAuth
helper, copy `id_token` from the OAuth token response and set the request's
Authorization tab to **Bearer Token**, pasting the ID token as its value.
Set `Content-Type` to `application/json` for requests with a body.

The ID token audience must equal `GOOGLE_CLIENT_ID`; its Google signature,
issuer, expiry, subject, and verified-email claim are checked by the API.

## Phase 2 endpoints

### Create a project

```http
POST http://localhost:3000/api/v1/projects
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
GET http://localhost:3000/api/v1/projects
```

Expected: `200 OK`. Newly authenticated users receive an empty `items` array
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
POST http://localhost:3000/api/v1/projects/{{projectId}}/targets
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
GET http://localhost:3000/api/v1/projects/{{projectId}}/targets
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

Missing or invalid bearer token: `401 Unauthorized`

```json
{
  "error": {
    "code": "unauthorized",
    "message": "A Google ID token bearer credential is required",
    "requestId": "c2bff7c8-5d6e-40b4-8f20-154b646a79e1",
    "details": null
  }
}
```

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
