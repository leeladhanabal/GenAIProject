# Phase 6 — Cloud deployment decision

**Status:** design direction selected; deployment remains blocked. No cloud
environment or project has been selected or provisioned.

Phase 6 was approved to begin. The selected direction for evaluation is a
Cloud Run API with GKE Standard workers. This is not authorization to provision
cloud infrastructure or a final production platform decision. The operational
owner remains undecided. This record prevents a local Docker design from being
treated as a production deployment without validating its isolation and
network controls.

## Current execution boundary

The local worker invokes Docker on its host to create one bounded k6 container
per run. It pins a public IPv4 target, disables redirects and IPv6, and applies
container resource and egress controls. This is not directly deployable as a
managed container workload: the cloud worker must not be given an unrestricted
host Docker daemon, and the platform must enforce equivalent per-run isolation,
resource ceilings, DNS/IP revalidation, and egress policy.

Production identity is also not selected. The current fixed local-mock identity
must remain unavailable in production. Cloud artifact storage and managed
database/queue services are not configured.

## Candidate platform shapes

| Shape | Advantages | Required design work |
|---|---|---|
| GKE Standard for API and workers | Kubernetes Jobs can isolate individual runs; network policy and resource quotas can be designed around each worker. | Replace the Docker CLI runtime with a Kubernetes Job adapter; design controlled egress, cluster operations, upgrades, secrets, and monitoring. |
| Cloud Run API with GKE Standard workers | Keeps the stateless API separate from the specialized execution plane. | Same worker redesign as above, plus service-to-cluster identity, private connectivity, and cross-service observability. |
| Cloud Run services/jobs | Less cluster administration for suitable workloads. | Prove maximum run duration, per-run isolation, pinned-target egress enforcement, cancellation, and recovery meet the threat model. The current host-Docker execution model cannot be assumed to work unchanged. |

**Selected design direction for evaluation:** prototype a Cloud Run API plus a
dedicated GKE Standard worker pool, with one Kubernetes Job per approved run.
This most closely matches the isolation and network-control requirements, but
is not an approved production platform and carries a greater operations
burden.

The current `DockerK6Runtime` cannot be reused as-is in this shape. The worker
must create and supervise a bounded Kubernetes Job through a narrow adapter;
it must not receive access to a general-purpose host Docker daemon. The
prototype must preserve the existing run claim/fencing, checksum, pinned-target,
cancel, recovery, workload-limit, and no-automatic-replay guarantees. The Job
must use a dedicated least-privilege service account, non-root execution,
resource quotas, and restrictive egress. Cloud storage access and PostgreSQL/
Redis connectivity need separate service identities and network paths.

Do not begin infrastructure implementation based on this design direction
alone.

## Required decisions before a staging deployment

1. Select the execution platform and whether API and worker use separate
   platforms.
2. Name the team/role accountable for on-call response, capacity, incident
   handling, and cloud-cost monitoring.
3. Specify cloud project/environment ownership, region, networking boundaries,
   and approved staging target.
4. Approve maximum test duration, per-run resource limits, and expected
   concurrent-run capacity.
5. Select production identity and secret-management approach.
6. Select managed PostgreSQL, Redis, and private artifact storage services and
   define backup retention, recovery point, and recovery time objectives.
7. Approve deployment permissions, production environment reviewers, and
   rollback authority.

Until these decisions are recorded, only local readiness work and deployment
design may proceed. No staging or production resources should be created.
