-- Structured script definitions are small plan metadata. JavaScript is compiled
-- on download; no script blobs or public object URLs are stored in PostgreSQL.
ALTER TABLE plan_versions
  ADD COLUMN specification_json JSONB,
  ADD COLUMN script_definition_json JSONB,
  ADD COLUMN script_reviewed_by UUID REFERENCES users(id),
  ADD COLUMN script_reviewed_at TIMESTAMPTZ,
  ADD CONSTRAINT plan_version_specification_object CHECK (
    specification_json IS NULL OR jsonb_typeof(specification_json) = 'object'
  ),
  ADD CONSTRAINT plan_version_script_object CHECK (
    script_definition_json IS NULL OR jsonb_typeof(script_definition_json) = 'object'
  ),
  ADD CONSTRAINT plan_version_review_requires_script CHECK (
    (script_reviewed_by IS NULL AND script_reviewed_at IS NULL) OR
    (script_definition_json IS NOT NULL AND script_reviewed_by IS NOT NULL AND script_reviewed_at IS NOT NULL)
  );

CREATE TABLE scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id UUID NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  k6_options_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX scenarios_plan_version_idx ON scenarios (plan_version_id);
