ALTER TABLE test_runs
  ADD COLUMN result_status TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (result_status IN ('pending', 'ready', 'failed', 'unavailable')),
  ADD COLUMN result_failure_code TEXT,
  ADD COLUMN sla_thresholds_json JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE TABLE project_sla_policies (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  thresholds_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  plan_version_id UUID REFERENCES plan_versions(id) ON DELETE SET NULL,
  run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('script', 'raw_results', 'run_summary', 'report_json', 'report_html', 'export')),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'available', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delete_after TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (run_id, kind)
);
CREATE INDEX artifacts_project_idx ON artifacts (project_id, created_at);
CREATE INDEX artifacts_delete_after_idx ON artifacts (delete_after) WHERE deleted_at IS NULL;
CREATE TABLE run_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL UNIQUE REFERENCES test_runs(id) ON DELETE CASCADE,
  metrics_json JSONB NOT NULL,
  sla_status TEXT NOT NULL CHECK (sla_status IN ('passed', 'failed', 'not_configured', 'incomplete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('json', 'html')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, format)
);
CREATE TABLE result_jobs (
  run_id UUID PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  worker_host_id TEXT NOT NULL,
  source_directory TEXT,
  source_type TEXT NOT NULL DEFAULT 'k6' CHECK (source_type IN ('k6', 'fixture')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE retention_policies (
  project_id UUID PRIMARY KEY REFERENCES projects(id),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days = 30),
  notice_days INTEGER CHECK (notice_days > 0 AND notice_days < 30),
  deletion_mode TEXT NOT NULL DEFAULT 'manual' CHECK (deletion_mode IN ('manual', 'automatic_after_notice')),
  notification_channels TEXT[] NOT NULL DEFAULT ARRAY['in_app'],
  notification_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE retention_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  run_id UUID NOT NULL UNIQUE,
  scheduled_deletion_at TIMESTAMPTZ NOT NULL,
  notice_days INTEGER NOT NULL CHECK (notice_days > 0),
  required_channels TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'notified' CHECK (status IN ('notified', 'deleting', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE retention_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  batch_id UUID REFERENCES retention_batches(id),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
  message TEXT NOT NULL,
  scheduled_deletion_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  recipient_email TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, recipient_user_id, channel)
);
CREATE INDEX retention_notifications_user_idx ON retention_notifications (recipient_user_id, created_at DESC);
CREATE TABLE deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id)
);
CREATE TABLE run_idempotency_tombstones (
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  run_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requested_by, idempotency_key)
);
