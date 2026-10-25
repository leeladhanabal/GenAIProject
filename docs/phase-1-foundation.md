# Phase 1 — Foundation and threat model

## Scope

This phase establishes the backend workspace, CI checks, an API health endpoint,
and reusable workload-policy logic. It does not implement identity, projects,
targets, persistence, queues, run execution, or later-phase endpoints.

## Security boundaries

- A load run must never be started solely because an API request was received.
  Later phases must require explicit authorization confirmation and run approval.
- The architecture's initial maximum is five concurrent runs. The policy
  function refuses configuration above that hard ceiling.
- Virtual-user and duration ceilings are policy inputs, not guessed defaults.
  They must be configured and reviewed before a future run-creation endpoint is
  implemented.
- Target registration and execution must validate approved domains, resolve and
  re-check DNS/IP destinations, block loopback, link-local, metadata, and private
  ranges by default, and prevent redirects from escaping target policy.
- Workers must be isolated from the API, resource-bounded, non-root, and
  restricted to approved egress. AI-generated scripts and uploaded
  specifications are untrusted input and require validation.
- The API must not log credentials, raw tokens, or sensitive request payloads.

## Threats and required mitigations

| Threat | Phase boundary / mitigation |
|---|---|
| SSRF via a supplied target URL | Validate scheme, hostname, resolved addresses, redirects, and DNS again at execution. Target registration belongs to Phase 2; execution-time checks belong to Phase 4. |
| Accidental or abusive traffic volume | Require authorization and explicit approval; enforce configured workload ceilings and the five-run global cap at API and worker layers. |
| Worker compromise or resource exhaustion | Isolate workers, restrict egress, apply CPU/memory/time limits, and use least-privilege identities. |
| Unsafe generated scripts or uploaded specifications | Treat content as untrusted; validate size/type and script behavior, prohibit unexpected destinations, and require human review. |
| Cross-user data exposure | Enforce project ownership/membership on every object access when tenant data is implemented in Phase 2. |
| Secrets exposed through logs or provider prompts | Keep secrets out of plans/scripts/prompts and redact structured logs. |

## Cloud environment plan

Use separate development, staging, and production environments. Keep API and
load workers as separate container workloads. PostgreSQL is the workflow source
of truth; Redis/BullMQ is job delivery machinery; private object storage is for
large artifacts. Do not provision cloud resources in this phase: the exact
Google Cloud worker runtime/networking design, identity provider, AI provider,
and email provider remain architecture decisions.

Staging must use synthetic data and a controlled test target. Production
credentials belong in a secret manager or protected CI environment, never in
source control. Deployments and migrations require controlled CI jobs and
backward-compatible schema sequencing.

## Recorded architecture decisions

| Decision | Phase 1 baseline |
|---|---|
| Backend framework | NestJS with TypeScript, organized as a modular monolith. |
| Workflow source of truth | PostgreSQL stores workflow state; the queue is delivery machinery only. |
| Load execution boundary | Run k6 in independently scalable, isolated worker containers rather than API processes. |
| Object storage | Use private Google Cloud Storage for large artifacts, not relational rows. |
| Provider integrations | Keep identity and AI behind provider-neutral boundaries until their pending decisions are resolved. |

## Open policy decisions

The architecture does not yet specify numeric virtual-user, duration, or
request-rate limits. These values need owner approval before any API can
schedule a run. This phase only implements validation against supplied
ceilings; it does not select or silently default those values.
