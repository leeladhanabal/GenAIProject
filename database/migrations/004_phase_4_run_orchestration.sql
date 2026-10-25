-- Earlier review timestamps did not persist the reviewed checksum. Preserve
-- history, but require a new checksum-bound review before executing those plans.
ALTER TABLE plan_versions ADD COLUMN script_reviewed_sha256 TEXT
  CHECK (script_reviewed_sha256 ~ '^[a-f0-9]{64}$');

CREATE TABLE test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  plan_version_id UUID NOT NULL REFERENCES plan_versions(id),
  target_id UUID NOT NULL REFERENCES targets(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelling', 'cancelled')),
  idempotency_key UUID NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  script_sha256 TEXT NOT NULL CHECK (script_sha256 ~ '^[a-f0-9]{64}$'),
  script_definition_json JSONB NOT NULL CHECK (jsonb_typeof(script_definition_json) = 'object'),
  limits_json JSONB NOT NULL CHECK (jsonb_typeof(limits_json) = 'object'),
  authorization_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  worker_host_id TEXT,
  execution_token UUID,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requested_by, idempotency_key),
  CHECK (status NOT IN ('running', 'cancelling') OR execution_token IS NOT NULL),
  CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR completed_at IS NOT NULL)
);
CREATE INDEX test_runs_project_created_idx ON test_runs (project_id, created_at DESC, id);
CREATE INDEX test_runs_status_queued_idx ON test_runs (status, queued_at);
CREATE INDEX test_runs_recovery_idx ON test_runs (worker_host_id, heartbeat_at)
  WHERE status IN ('running', 'cancelling');

CREATE TABLE run_outbox (
  run_id UUID PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  last_dispatched_at TIMESTAMPTZ,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
