import {
  BadRequestException, ConflictException, ForbiddenException, HttpException,
  Injectable, NotFoundException, GoneException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { renderScript, ScriptDefinition } from '../plans/planning-content';
import { CreateRunDto } from './dto/create-run.dto';
import { readRunLimits, RUN_ADMISSION_LOCK, RunRow, runResponse, SqlClient, validateRunWorkload } from './run-domain';

@Injectable()
export class RunsService {
  constructor(private readonly database: DatabaseService, private readonly config: ConfigService) {}

  async policy(user: AuthenticatedUser, planId: string) {
    await this.assertPlanAccess(user, planId);
    return readRunLimits(this.config);
  }

  async create(user: AuthenticatedUser, planId: string, key: string, input: CreateRunDto) {
    if (typeof key !== 'string' || !isUUID(key)) throw new BadRequestException('Idempotency-Key must be a UUID');
    if (input.approved !== true || input.authorizationConfirmed !== true) {
      throw new BadRequestException('Explicit run approval and target authorization confirmation are required');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ planId,
      targetId: input.targetId, planVersion: input.planVersion,
      virtualUsers: input.workload.virtualUsers, durationSeconds: input.workload.durationSeconds,
    })).digest('hex');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      // One database lock serializes global admission and idempotency across
      // all API replicas. Worker claim uses the same lock.
      await client.query('SELECT pg_advisory_xact_lock($1)', [RUN_ADMISSION_LOCK]);
      const userId = await this.userId(client, user);
      const access = await client.query<{ project_id: string }>(
        `SELECT p.project_id FROM test_plans p
         JOIN projects pr ON pr.id = p.project_id
         JOIN project_members pm ON pm.project_id = p.project_id
         WHERE p.id = $1 AND pm.user_id = $2 AND pr.deleted_at IS NULL AND p.status <> 'archived'`,
        [planId, userId],
      );
      if (!access.rows[0]) throw new NotFoundException('Plan not found');
      const existing = await client.query<RunRow>(
        'SELECT * FROM test_runs WHERE requested_by = $1 AND idempotency_key = $2', [userId, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_sha256 !== fingerprint) throw new ConflictException('Idempotency-Key was used for a different run request');
        await client.query('COMMIT');
        return runResponse(existing.rows[0]);
      }
      const deleted = await client.query('SELECT 1 FROM run_idempotency_tombstones WHERE requested_by = $1 AND idempotency_key = $2', [userId, key]);
      if (deleted.rowCount) throw new GoneException({ code: 'run_data_deleted', message: 'This approval belongs to a deleted run. A new test requires a new idempotency key.' });
      const version = await client.query<{
        id: string; script_definition_json: ScriptDefinition | null;
        script_reviewed_sha256: string | null; script_reviewed_at: Date | null;
      }>('SELECT * FROM plan_versions WHERE plan_id = $1 AND version = $2', [planId, input.planVersion]);
      const selected = version.rows[0];
      if (!selected) throw new NotFoundException('Plan version not found');
      if (!selected.script_definition_json || !selected.script_reviewed_at ||
          selected.script_reviewed_sha256 !== renderScript(selected.script_definition_json).sha256) {
        throw new ConflictException({ code: 'script_review_required', message: 'Record a checksum-bound review for this plan version before starting a run' });
      }
      const definition = selected.script_definition_json;
      if (definition.targetId !== input.targetId) throw new ConflictException('Target must match the reviewed script');
      if (definition.workload.virtualUsers !== input.workload.virtualUsers ||
          definition.workload.durationSeconds !== input.workload.durationSeconds) {
        throw new ConflictException('Workload must match the reviewed version. Save and review a new version to change it.');
      }
      const target = await client.query<{ base_url: string }>(
        `SELECT base_url FROM targets WHERE id = $1 AND project_id = $2
         AND disabled_at IS NULL AND authorization_confirmed_at IS NOT NULL`,
        [input.targetId, access.rows[0].project_id],
      );
      if (!target.rows[0]) throw new NotFoundException('Target not found');
      if (target.rows[0].base_url !== definition.baseUrl) throw new ConflictException('Target changed after script review');
      const limits = readRunLimits(this.config);
      validateRunWorkload(input.workload, definition, limits);
      const count = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM test_runs WHERE status IN ('queued', 'running', 'cancelling')",
      );
      if (Number(count.rows[0].count) >= limits.maxConcurrentRuns) {
        throw new HttpException({ code: 'run_capacity_exceeded',
          message: 'Run capacity is full. Wait for an active or queued run to finish.' }, 429);
      }
      const result = await client.query<RunRow>(
        `INSERT INTO test_runs (project_id, plan_version_id, target_id, requested_by,
           idempotency_key, request_sha256, script_sha256, script_definition_json, limits_json, sla_thresholds_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB,
           COALESCE((SELECT thresholds_json FROM project_sla_policies WHERE project_id = $1), '{}'::JSONB)) RETURNING *`,
        [access.rows[0].project_id, selected.id, input.targetId, userId, key, fingerprint,
          selected.script_reviewed_sha256, JSON.stringify(definition), JSON.stringify(limits)],
      );
      const run = result.rows[0];
      await client.query('INSERT INTO run_outbox (run_id) VALUES ($1)', [run.id]);
      await client.query(
        `INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'run.approved', 'run', $3, $4::JSONB)`,
        [run.project_id, userId, run.id, JSON.stringify({ planVersion: input.planVersion,
          scriptSha256: run.script_sha256, workload: input.workload, limits })],
      );
      await client.query('COMMIT');
      return runResponse(run);
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async get(user: AuthenticatedUser, runId: string) {
    const row = await this.findAccessibleRun(user, runId);
    return runResponse(row);
  }

  async cancel(user: AuthenticatedUser, runId: string) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.userId(client, user);
      const result = await client.query<RunRow>(
        `SELECT r.* FROM test_runs r JOIN project_members pm ON pm.project_id = r.project_id
         JOIN projects p ON p.id = r.project_id
         WHERE r.id = $1 AND pm.user_id = $2 AND p.deleted_at IS NULL FOR UPDATE OF r`, [runId, userId],
      );
      let run = result.rows[0];
      if (!run) throw new NotFoundException('Run not found');
      if (run.status === 'queued' || run.status === 'running') {
        const next = run.status === 'queued' ? 'cancelled' : 'cancelling';
        const updated = await client.query<RunRow>(
          `UPDATE test_runs SET status = $2, completed_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE completed_at END
           WHERE id = $1 RETURNING *`, [run.id, next],
        );
        run = updated.rows[0];
        await client.query(
          `INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id, details_json)
           VALUES ($1, $2, 'run.cancellation_requested', 'run', $3, $4::JSONB)`,
          [run.project_id, userId, run.id, JSON.stringify({ status: next })],
        );
      }
      await client.query('COMMIT');
      return runResponse(run);
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  private async assertPlanAccess(user: AuthenticatedUser, planId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const result = await client.query(
        `SELECT 1 FROM test_plans p JOIN project_members pm ON pm.project_id = p.project_id
         JOIN projects pr ON pr.id = p.project_id
         WHERE p.id = $1 AND pm.user_id = $2 AND pr.deleted_at IS NULL`, [planId, userId],
      );
      if (!result.rowCount) throw new NotFoundException('Plan not found');
    } finally { client.release(); }
  }

  private async findAccessibleRun(user: AuthenticatedUser, runId: string): Promise<RunRow> {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const result = await client.query<RunRow>(
        `SELECT r.*, (SELECT metrics_json FROM run_summaries WHERE run_id = r.id) AS summary_json
         FROM test_runs r JOIN project_members pm ON pm.project_id = r.project_id
         JOIN projects p ON p.id = r.project_id
         WHERE r.id = $1 AND pm.user_id = $2 AND p.deleted_at IS NULL`, [runId, userId],
      );
      if (!result.rows[0]) throw new NotFoundException('Run not found');
      return result.rows[0];
    } finally { client.release(); }
  }

  private async userId(client: SqlClient, user: AuthenticatedUser): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (oidc_issuer, oidc_subject, email, display_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
       WHERE users.disabled_at IS NULL RETURNING id`, [user.issuer, user.subject, user.email, user.displayName],
    );
    if (!result.rows[0]) throw new ForbiddenException('This account is disabled');
    return result.rows[0].id;
  }
}
