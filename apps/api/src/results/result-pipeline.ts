import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArtifactStorage, readResultFile } from '../artifacts/artifact-storage';
import { renderScript } from '../plans/planning-content';
import { RunRow, SqlClient, SqlDatabase, positiveSetting } from '../runs/run-domain';
import { htmlReport, SlaThresholds, summarizeK6 } from './summary';

export function stagingRoot(config: ConfigService): string { return resolve(config.get<string>('RESULT_STAGING_DIR') ?? '.local/result-staging'); }
export async function checkedStagingDirectory(config: ConfigService, directory: string, runId: string): Promise<string> {
  const root = stagingRoot(config);
  if (resolve(directory) !== join(root, runId)) throw new Error('invalid_result_directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  if (canonical !== join(await realpath(root), runId)) throw new Error('invalid_result_directory');
  return canonical;
}

export class ResultPipeline {
  constructor(private readonly database: SqlDatabase, private readonly storage: ArtifactStorage,
    private readonly config: ConfigService, private readonly hostId: string) {}

  async processOne(): Promise<boolean> {
    const client = await this.database.connect();
    let runId: string | undefined;
    let directory: string | null = null;
    try {
      await client.query('BEGIN');
      const job = await client.query<{ run_id: string; source_directory: string | null; source_type: 'k6' | 'fixture'; attempts: number; status: string }>(
        `SELECT j.* FROM result_jobs j JOIN projects p ON p.id = (SELECT project_id FROM test_runs WHERE id = j.run_id)
         WHERE j.worker_host_id = $1 AND j.source_directory IS NOT NULL
           AND ((j.status IN ('pending', 'completed') AND j.next_attempt_at <= NOW()) OR p.deleted_at IS NOT NULL)
         ORDER BY j.created_at LIMIT 1`, [this.hostId],
      );
      if (!job.rows[0]) { await client.query('COMMIT'); return false; }
      let selected = job.rows[0]; runId = selected.run_id; directory = selected.source_directory;
      const result = await client.query<RunRow & { deleted_at: Date | null; sla_thresholds_json: SlaThresholds }>(
        `SELECT r.*, p.deleted_at FROM test_runs r JOIN projects p ON p.id = r.project_id
         WHERE r.id = $1 FOR UPDATE OF p`, [runId],
      );
      const run = result.rows[0];
      if (!run || !directory) throw new Error('result_source_missing');
      const locked = await client.query<typeof selected>('SELECT * FROM result_jobs WHERE run_id = $1 FOR UPDATE', [runId]);
      selected = locked.rows[0];
      if (!selected?.source_directory) { await client.query('COMMIT'); return true; }
      directory = selected.source_directory;
      if (selected.status === 'completed') {
        try { await rm(await checkedStagingDirectory(this.config, directory, runId), { recursive: true, force: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            await client.query("UPDATE result_jobs SET next_attempt_at = NOW() + INTERVAL '30 seconds' WHERE run_id = $1", [runId]);
            await client.query('COMMIT'); return true;
          }
        }
        await client.query('UPDATE result_jobs SET source_directory = NULL WHERE run_id = $1', [runId]);
        await client.query('COMMIT'); return true;
      }
      directory = await checkedStagingDirectory(this.config, directory, runId);
      if (run.deleted_at) {
        await rm(directory, { recursive: true, force: true });
        await client.query("UPDATE result_jobs SET status = 'cancelled', source_directory = NULL WHERE run_id = $1", [runId]);
        await client.query('COMMIT'); return true;
      }
      const maximum = positiveSetting(this.config, 'MAX_ARTIFACT_BYTES', 33554432);
      const rawSummary = await readResultFile(directory, 'summary.json', Math.min(maximum, 2097152));
      const rawResults = await readResultFile(directory, 'results.ndjson', maximum);
      const summary = summarizeK6(JSON.parse(rawSummary.toString('utf8')), run.sla_thresholds_json, selected.source_type);
      if (run.status !== 'completed') {
        if (summary.slaStatus === 'passed') summary.slaStatus = 'incomplete';
        summary.findings[2] = `SLA status: ${summary.slaStatus}.`;
        summary.findings.push('Partial results from a run that did not complete successfully.');
      }
      const report = Buffer.from(JSON.stringify({ schemaVersion: 1, runId, runStatus: run.status,
        partial: run.status !== 'completed', scriptSha256: run.script_sha256, summary }, null, 2));
      const files = [
        { kind: 'run_summary', extension: 'json', type: 'application/json', data: rawSummary },
        { kind: 'raw_results', extension: 'ndjson', type: 'application/x-ndjson', data: rawResults },
        { kind: 'script', extension: 'js', type: 'application/javascript', data: Buffer.from(renderScript(run.script_definition_json).content) },
        { kind: 'report_json', extension: 'json', type: 'application/json', data: report },
        { kind: 'report_html', extension: 'html', type: 'text/html', data: Buffer.from(htmlReport(run.id, summary)) },
      ];
      if (createHash('sha256').update(files[2].data).digest('hex') !== run.script_sha256) throw new Error('artifact_content_conflict');
      // Reserve metadata before object I/O, so unknown/partial writes remain
      // discoverable for retries and project deletion after a process crash.
      for (const file of files) {
        const sha = createHash('sha256').update(file.data).digest('hex');
        const key = `${run.project_id}/${run.id}/${file.kind}-${sha}.${file.extension}`;
        await client.query(
          `INSERT INTO artifacts (project_id, plan_version_id, run_id, kind, object_key, sha256, size_bytes, content_type, delete_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ + INTERVAL '30 days')
           ON CONFLICT (run_id, kind) DO NOTHING`,
          [run.project_id, run.plan_version_id, run.id, file.kind, key, sha, file.data.length, file.type, run.completed_at],
        );
      }
      await client.query('COMMIT');
      await client.query('BEGIN');
      // Lock project before upload. Deletion waits for in-flight uploads and
      // then sees every reserved object, including incomplete uploads.
      const active = await client.query('SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [run.project_id]);
      if (!active.rowCount) { await client.query('ROLLBACK'); return true; }
      const current = await client.query<{ status: string }>('SELECT status FROM result_jobs WHERE run_id = $1 FOR UPDATE', [runId]);
      if (current.rows[0]?.status !== 'pending') { await client.query('COMMIT'); return true; }
      for (const file of files) {
        const artifact = await client.query<{ id: string; object_key: string; sha256: string }>(
          'SELECT id, object_key, sha256 FROM artifacts WHERE run_id = $1 AND kind = $2', [runId, file.kind],
        );
        const row = artifact.rows[0];
        if (!row || row.sha256 !== createHash('sha256').update(file.data).digest('hex')) throw new Error('artifact_content_conflict');
        await this.storage.put(row.object_key, file.data, file.type);
        await client.query("UPDATE artifacts SET status = 'available' WHERE id = $1", [row.id]);
        if (file.kind.startsWith('report_')) await client.query(
          'INSERT INTO reports (run_id, artifact_id, format) VALUES ($1, $2, $3) ON CONFLICT (run_id, format) DO NOTHING',
          [runId, row.id, file.extension],
        );
      }
      await client.query(
        'INSERT INTO run_summaries (run_id, metrics_json, sla_status) VALUES ($1, $2::JSONB, $3) ON CONFLICT (run_id) DO NOTHING',
        [runId, JSON.stringify(summary), summary.slaStatus],
      );
      await client.query("UPDATE test_runs SET result_status = 'ready', result_failure_code = NULL WHERE id = $1", [runId]);
      await client.query("UPDATE result_jobs SET status = 'completed', failure_code = NULL WHERE run_id = $1", [runId]);
      await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
        VALUES ($1, $2, 'run.results_ready', 'run', $3)`, [run.project_id, run.requested_by, runId]);
      await client.query('COMMIT');
      try {
        await rm(directory, { recursive: true, force: true });
        await client.query('UPDATE result_jobs SET source_directory = NULL WHERE run_id = $1', [runId]);
      } catch { /* Completed results remain ready; the next pass retries private staging cleanup. */ }
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      if (runId) await this.recordFailure(client, runId, error);
      else throw error;
      return true;
    } finally { client.release(); }
  }

  private async recordFailure(client: SqlClient, runId: string, error: unknown) {
    const code = error instanceof SyntaxError ? 'invalid_k6_summary' : error instanceof Error &&
      ['invalid_k6_summary', 'result_file_too_large', 'invalid_result_directory', 'artifact_content_conflict'].includes(error.message)
      ? error.message : 'result_processing_failed';
    const result = await client.query<{ attempts: number }>(
      `UPDATE result_jobs SET attempts = attempts + 1, failure_code = $2,
       status = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
       next_attempt_at = NOW() + LEAST(300, POWER(2, LEAST(attempts + 1, 9))) * INTERVAL '1 second'
       WHERE run_id = $1 AND status = 'pending' RETURNING attempts`, [runId, code],
    );
    if (!result.rowCount) return;
    await client.query("UPDATE test_runs SET result_status = $2, result_failure_code = $3 WHERE id = $1",
      [runId, (result.rows[0]?.attempts ?? 5) >= 5 ? 'failed' : 'pending', code]);
  }
}
