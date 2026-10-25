CREATE TABLE test_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT test_plans_status_check
    CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE INDEX test_plans_project_created_idx
  ON test_plans (project_id, created_at DESC, id);

CREATE TABLE plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  workload_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  requirements_text TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plan_versions_plan_version_unique UNIQUE (plan_id, version),
  CONSTRAINT plan_versions_requirements_not_empty
    CHECK (LENGTH(BTRIM(requirements_text)) > 0)
);

CREATE INDEX plan_versions_plan_version_idx
  ON plan_versions (plan_id, version DESC);
