import { randomUUID } from 'node:crypto';
import { RunRow, SqlDatabase, RUN_ADMISSION_LOCK, RunLimits } from '../../api/src/runs/run-domain';

export class RunStore {
  constructor(private readonly database: SqlDatabase) {}

  async claim(runId: string, hostId: string, limits: RunLimits): Promise<RunRow | null> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [RUN_ADMISSION_LOCK]);
      const active = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM test_runs WHERE status IN ('running', 'cancelling')",
      );
      if (Number(active.rows[0].count) >= limits.maxConcurrentRuns) {
        await client.query('COMMIT'); return null;
      }
      const result = await client.query<RunRow>(
        `UPDATE test_runs SET status = 'running', started_at = NOW(), heartbeat_at = NOW(),
           worker_host_id = $2, execution_token = $3,
           deadline_at = NOW() + ((script_definition_json->'workload'->>'durationSeconds')::INTEGER + 30) * INTERVAL '1 second'
         WHERE id = $1 AND status = 'queued' RETURNING *`, [runId, hostId, randomUUID()],
      );
      const run = result.rows[0];
      if (run) await client.query(
        `INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'run.started', 'run', $3)`, [run.project_id, run.requested_by, run.id],
      );
      await client.query('COMMIT'); return run ?? null;
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async executionContext(run: RunRow) {
    const result = await this.database.query<{
      base_url: string; approved_domains: string[]; script_reviewed_sha256: string | null;
    }>(
      `SELECT t.base_url, t.approved_domains, pv.script_reviewed_sha256 FROM test_runs r
       JOIN targets t ON t.id = r.target_id AND t.project_id = r.project_id
       JOIN projects p ON p.id = r.project_id
       JOIN project_members pm ON pm.project_id = r.project_id AND pm.user_id = r.requested_by
       JOIN users u ON u.id = r.requested_by
       JOIN plan_versions pv ON pv.id = r.plan_version_id
       WHERE r.id = $1 AND r.execution_token = $2 AND r.status = 'running'
         AND t.disabled_at IS NULL AND p.deleted_at IS NULL AND u.disabled_at IS NULL
         AND t.authorization_confirmed_at IS NOT NULL AND r.approved_at IS NOT NULL
         AND r.authorization_confirmed_at IS NOT NULL AND pv.script_reviewed_at IS NOT NULL`,
      [run.id, run.execution_token],
    );
    return result.rows[0] ?? null;
  }

  async heartbeat(run: RunRow): Promise<boolean> {
    const result = await this.database.query<{ status: string }>(
      `UPDATE test_runs r SET heartbeat_at = NOW() WHERE r.id = $1 AND r.execution_token = $2
       AND r.status IN ('running', 'cancelling') AND EXISTS (
         SELECT 1 FROM targets t JOIN projects p ON p.id = t.project_id
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = r.requested_by
         JOIN users u ON u.id = pm.user_id
         JOIN plan_versions pv ON pv.id = r.plan_version_id
         JOIN test_plans pl ON pl.id = pv.plan_id
         WHERE t.id = r.target_id AND t.project_id = r.project_id
           AND t.disabled_at IS NULL AND t.authorization_confirmed_at IS NOT NULL
           AND t.base_url = r.script_definition_json->>'baseUrl'
           AND p.deleted_at IS NULL AND u.disabled_at IS NULL AND pl.status <> 'archived'
           AND pv.script_reviewed_at IS NOT NULL AND pv.script_reviewed_sha256 = r.script_sha256
       ) RETURNING r.status`, [run.id, run.execution_token],
    );
    return result.rows[0]?.status === 'running';
  }

  async finish(run: RunRow, failureCode: string | null, resultDirectory?: string): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RunRow>(
        `UPDATE test_runs SET status = CASE WHEN status = 'cancelling' AND failure_code IS NULL
             THEN 'cancelled' WHEN $3::TEXT IS NOT NULL OR failure_code IS NOT NULL THEN 'failed' ELSE 'completed' END,
           completed_at = NOW(), heartbeat_at = NOW(), result_status = CASE WHEN $4::TEXT IS NULL THEN 'unavailable' ELSE 'pending' END,
           failure_code = CASE WHEN status = 'cancelling' AND failure_code IS NULL THEN NULL ELSE COALESCE(failure_code, $3::TEXT) END
         WHERE id = $1 AND execution_token = $2 AND status IN ('running', 'cancelling') RETURNING *`,
        [run.id, run.execution_token, failureCode, resultDirectory ?? null],
      );
      const updated = result.rows[0];
      if (updated && resultDirectory) await client.query(
        `INSERT INTO result_jobs (run_id, worker_host_id, source_directory) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING`,
        [run.id, run.worker_host_id, resultDirectory],
      );
      if (updated) await client.query(
        `INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, $3, 'run', $4, $5::JSONB)`,
        [run.project_id, run.requested_by, `run.${updated.status}`, run.id,
          JSON.stringify({ failureCode: updated.failure_code })],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  // Recovery fences the old processor before touching its container. Capacity
  // remains reserved until that container's removal has been confirmed.
  async fenceOrphan(hostId: string): Promise<RunRow | null> {
    const result = await this.database.query<RunRow>(
      `UPDATE test_runs SET status = 'cancelling', execution_token = $2,
         failure_code = CASE WHEN status = 'cancelling' THEN failure_code ELSE COALESCE(failure_code, 'worker_lost') END, heartbeat_at = NOW()
       WHERE id = (SELECT id FROM test_runs WHERE worker_host_id = $1
         AND status IN ('running', 'cancelling')
         AND (heartbeat_at < NOW() - INTERVAL '30 seconds' OR deadline_at < NOW())
         ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [hostId, randomUUID()],
    );
    return result.rows[0] ?? null;
  }
}
