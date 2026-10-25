import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { ARTIFACT_STORAGE, ArtifactStorage } from '../artifacts/artifact-storage';
import { DatabaseService } from '../database/database.service';
import { RUN_ADMISSION_LOCK, SqlClient, positiveSetting } from '../runs/run-domain';
import { RetentionPolicyDto, SlaPolicyDto } from './phase5.dto';

interface ArtifactRow {
  id: string; project_id: string; run_id: string | null; kind: string; object_key: string;
  sha256: string; size_bytes: string; content_type: string; created_at: Date; status: string;
}

@Injectable()
export class Phase5Service {
  private readonly signingSecret: Buffer;
  constructor(private readonly database: DatabaseService, private readonly config: ConfigService,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage) {
    const secret = config.get<string>('ARTIFACT_SIGNING_SECRET');
    if (secret && Buffer.byteLength(secret) < 32) throw new Error('ARTIFACT_SIGNING_SECRET must have at least 32 bytes');
    this.signingSecret = secret ? Buffer.from(secret) : randomBytes(32);
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

  private async project(client: SqlClient, userId: string, projectId: string, lock = false) {
    const result = await client.query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM projects p JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = $1 AND pm.user_id = $2 AND p.deleted_at IS NULL ${lock ? 'FOR UPDATE OF p' : ''}`, [projectId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('Project not found');
    return result.rows[0];
  }

  async reports(user: AuthenticatedUser, runId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const run = await client.query<{ project_id: string; result_status: string }>(
        `SELECT r.project_id, r.result_status FROM test_runs r JOIN project_members pm ON pm.project_id = r.project_id
         JOIN projects p ON p.id = r.project_id WHERE r.id = $1 AND pm.user_id = $2 AND p.deleted_at IS NULL`, [runId, userId],
      );
      if (!run.rows[0]) throw new NotFoundException('Run not found');
      const result = await client.query(
        `SELECT rp.id, rp.format, rp.artifact_id AS "artifactId", rp.created_at AS "createdAt",
           a.sha256, a.size_bytes AS "sizeBytes" FROM reports rp JOIN artifacts a ON a.id = rp.artifact_id
         WHERE rp.run_id = $1 AND a.status = 'available' AND a.deleted_at IS NULL ORDER BY rp.format`, [runId],
      );
      return { runId, resultStatus: run.rows[0].result_status, items: result.rows };
    } finally { client.release(); }
  }

  async artifacts(user: AuthenticatedUser, projectId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user); await this.project(client, userId, projectId);
      const result = await client.query(
        `SELECT id, run_id AS "runId", kind, sha256, size_bytes AS "sizeBytes", content_type AS "contentType",
         created_at AS "createdAt", delete_after AS "deleteAfter" FROM artifacts
         WHERE project_id = $1 AND status = 'available' AND deleted_at IS NULL ORDER BY created_at, id`, [projectId],
      );
      return { items: result.rows };
    } finally { client.release(); }
  }

  private async artifact(client: SqlClient, userId: string, artifactId: string): Promise<ArtifactRow> {
    const result = await client.query<ArtifactRow>(
      `SELECT a.* FROM artifacts a JOIN project_members pm ON pm.project_id = a.project_id
       JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND pm.user_id = $2
       AND p.deleted_at IS NULL AND a.deleted_at IS NULL AND a.status = 'available'`, [artifactId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('Artifact not found');
    return result.rows[0];
  }

  async downloadLink(user: AuthenticatedUser, artifactId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user); const artifact = await this.artifact(client, userId, artifactId);
      const ttl = Math.min(300, positiveSetting(this.config, 'ARTIFACT_LINK_TTL_SECONDS', 60));
      const exp = Date.now() + ttl * 1000;
      const payload = Buffer.from(JSON.stringify({ id: artifact.id, userId, sha256: artifact.sha256, exp })).toString('base64url');
      const token = `${payload}.${createHmac('sha256', this.signingSecret).update(payload).digest('hex')}`;
      const base = `http://127.0.0.1:${this.config.get<string>('PORT') ?? '3000'}/api/v1`;
      await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
        VALUES ($1, $2, 'artifact.download_link_issued', 'artifact', $3)`, [artifact.project_id, userId, artifactId]);
      return { artifactId, url: `${base}/artifacts/${artifact.id}/content?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(exp).toISOString(), sha256: artifact.sha256 };
    } finally { client.release(); }
  }

  async download(user: AuthenticatedUser, artifactId: string, token: string) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1]) || parts[0].length > 2048) throw new ForbiddenException('Invalid download link');
    const signature = createHmac('sha256', this.signingSecret).update(parts[0]).digest();
    if (!timingSafeEqual(signature, Buffer.from(parts[1], 'hex'))) throw new ForbiddenException('Invalid download link');
    let payload: { id: string; userId: string; sha256: string; exp: number };
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw new ForbiddenException('Invalid download link'); }
    if (!payload || typeof payload !== 'object' || payload.id !== artifactId || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) throw new ForbiddenException('Download link expired or invalid');
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      if (userId !== payload.userId) throw new ForbiddenException('Invalid download link');
      const artifact = await this.artifact(client, userId, artifactId);
      if (artifact.sha256 !== payload.sha256) throw new ForbiddenException('Invalid download link');
      await this.project(client, userId, artifact.project_id);
      const content = await this.storage.get(artifact.object_key);
      if (content.length !== Number(artifact.size_bytes) || createHash('sha256').update(content).digest('hex') !== artifact.sha256) {
        throw new ConflictException('Artifact integrity verification failed');
      }
      return { content, contentType: artifact.content_type, filename: `${artifact.id}.${artifact.object_key.split('.').at(-1)}` };
    } finally { client.release(); }
  }

  async sla(user: AuthenticatedUser, projectId: string, policy?: SlaPolicyDto) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user); await this.project(client, userId, projectId);
      if (policy) await client.query(
        `INSERT INTO project_sla_policies (project_id, thresholds_json) VALUES ($1, $2::JSONB)
         ON CONFLICT (project_id) DO UPDATE SET thresholds_json = EXCLUDED.thresholds_json, updated_at = NOW()`, [projectId, JSON.stringify(policy)],
      );
      const result = await client.query<{ thresholds_json: SlaPolicyDto }>('SELECT thresholds_json FROM project_sla_policies WHERE project_id = $1', [projectId]);
      return { projectId, thresholds: result.rows[0]?.thresholds_json ?? {}, appliesTo: 'future_run_approvals' };
    } finally { client.release(); }
  }

  async retryResults(user: AuthenticatedUser, runId: string) {
    await this.reports(user, runId);
    const result = await this.database.query(
      `UPDATE result_jobs SET status = 'pending', attempts = 0, next_attempt_at = NOW(), failure_code = NULL
       WHERE run_id = $1 AND status = 'failed' AND source_directory IS NOT NULL RETURNING run_id`, [runId],
    );
    if (!result.rowCount) throw new ConflictException('Only failed processing jobs with retained source data can be retried');
    await this.database.query("UPDATE test_runs SET result_status = 'pending', result_failure_code = NULL WHERE id = $1", [runId]);
    return { runId, resultStatus: 'pending', loadTestRerun: false };
  }

  async compare(user: AuthenticatedUser, runId: string, baselineId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const result = await client.query<{ id: string; project_id: string; script_sha256: string;
        metrics_json: { source: string; requestsPerSecond: number | null; errorRate: number | null; latencyMs: { p95: number | null } } }>(
        `SELECT r.id, r.project_id, r.script_sha256, s.metrics_json FROM test_runs r
         JOIN project_members pm ON pm.project_id = r.project_id JOIN projects p ON p.id = r.project_id
         LEFT JOIN run_summaries s ON s.run_id = r.id
         WHERE r.id IN ($1, $2) AND pm.user_id = $3 AND p.deleted_at IS NULL`, [runId, baselineId, userId],
      );
      const candidate = result.rows.find((row) => row.id === runId);
      const baseline = result.rows.find((row) => row.id === baselineId);
      if (!candidate || !baseline) throw new NotFoundException('Run not found');
      if (candidate.project_id !== baseline.project_id) throw new BadRequestException('Compare runs within the same project');
      if (!candidate.metrics_json || !baseline.metrics_json) throw new ConflictException('Both runs need processed results');
      const delta = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
      return { runId, baselineRunId: baselineId,
        comparable: candidate.script_sha256 === baseline.script_sha256 && candidate.metrics_json.source === baseline.metrics_json.source,
        note: 'Deltas are candidate minus baseline. Different scripts or synthetic/measured sources are not treated as equivalent tests.',
        deltas: { requestsPerSecond: delta(candidate.metrics_json.requestsPerSecond, baseline.metrics_json.requestsPerSecond),
          errorRate: delta(candidate.metrics_json.errorRate, baseline.metrics_json.errorRate),
          p95ResponseTimeMs: delta(candidate.metrics_json.latencyMs.p95, baseline.metrics_json.latencyMs.p95) } };
    } finally { client.release(); }
  }

  async retention(user: AuthenticatedUser, projectId: string, input?: RetentionPolicyDto) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user); await this.project(client, userId, projectId);
      const defaultNoticeDays = positiveSetting(this.config, 'RETENTION_NOTICE_DAYS', 2);
      if (defaultNoticeDays > 29) throw new BadRequestException('RETENTION_NOTICE_DAYS must be between 1 and 29');
      const defaultEmail = this.config.get<string>('NOTIFICATION_EMAIL')?.trim() || null;
      if (input) {
        if (input.deletionMode === 'automatic_after_notice' && (this.config.get<string>('AUTOMATIC_RETENTION_APPROVED') !== 'true' || !input.noticeDays)) {
          throw new ConflictException('Automatic retention requires explicit approved policy configuration and noticeDays');
        }
        if (input.channels.includes('email') && !input.notificationEmail) throw new BadRequestException('notificationEmail is required for email notices');
        await client.query(
          `INSERT INTO retention_policies (project_id, notice_days, deletion_mode, notification_channels, notification_email)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id) DO UPDATE SET notice_days = EXCLUDED.notice_days,
           deletion_mode = EXCLUDED.deletion_mode, notification_channels = EXCLUDED.notification_channels,
           notification_email = EXCLUDED.notification_email, updated_at = NOW()`,
          [projectId, input.noticeDays ?? defaultNoticeDays, input.deletionMode, [...new Set(input.channels)], input.notificationEmail ?? defaultEmail],
        );
      }
      const result = await client.query<{ retention_days: number; notice_days: number | null; deletion_mode: string; notification_channels: string[]; notification_email: string | null }>(
        'SELECT * FROM retention_policies WHERE project_id = $1', [projectId],
      );
      const policy = result.rows[0];
      const notices = await client.query(
        `SELECT id, run_id AS "runId", scheduled_deletion_at AS "scheduledDeletionAt", status
         FROM retention_batches WHERE project_id = $1 ORDER BY created_at DESC`, [projectId],
      );
      return { projectId, retentionDays: policy?.retention_days ?? 30, noticeDays: policy?.notice_days ?? defaultNoticeDays,
        deletionMode: policy?.deletion_mode ?? 'manual', channels: policy?.notification_channels ?? ['in_app'],
        notificationEmail: policy?.notification_email ?? defaultEmail,
        automaticDeletionEnabled: this.config.get<string>('AUTOMATIC_RETENTION_APPROVED') === 'true' && policy?.deletion_mode === 'automatic_after_notice',
        scope: 'completed_run_data_and_artifacts', notices: notices.rows };
    } finally { client.release(); }
  }

  async notifications(user: AuthenticatedUser, projectId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user); await this.project(client, userId, projectId);
      const result = await client.query(
        `SELECT id, message, scheduled_deletion_at AS "scheduledDeletionAt", notified_at AS "notifiedAt", read_at AS "readAt",
         status, channel, created_at AS "createdAt" FROM retention_notifications
         WHERE project_id = $1 AND recipient_user_id = $2 ORDER BY created_at DESC LIMIT 100`, [projectId, userId],
      );
      return { items: result.rows };
    } finally { client.release(); }
  }

  async readNotification(user: AuthenticatedUser, notificationId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const result = await client.query(
        `UPDATE retention_notifications n SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND recipient_user_id = $2
         AND EXISTS (SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id = p.id
           WHERE p.id = n.project_id AND p.deleted_at IS NULL AND pm.user_id = $2)
         RETURNING id, read_at AS "readAt"`, [notificationId, userId],
      );
      if (!result.rows[0]) throw new NotFoundException('Notification not found'); return result.rows[0];
    } finally { client.release(); }
  }

  async requestDeletion(user: AuthenticatedUser, projectId: string, confirmed: boolean) {
    if (confirmed !== true) throw new BadRequestException('Explicit deletion confirmation is required');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)', [RUN_ADMISSION_LOCK]);
      const userId = await this.userId(client, user);
      const prior = await client.query('SELECT id, status FROM deletion_requests WHERE project_id = $1 AND requested_by = $2', [projectId, userId]);
      if (prior.rows[0]) { await client.query('COMMIT'); return prior.rows[0]; }
      await this.project(client, userId, projectId, true);
      const active = await client.query("SELECT 1 FROM test_runs WHERE project_id = $1 AND status IN ('running', 'cancelling') LIMIT 1", [projectId]);
      if (active.rowCount) throw new ConflictException('Cancel active runs and wait for them to stop before deleting the project');
      await client.query("UPDATE test_runs SET status = 'cancelled', completed_at = NOW() WHERE project_id = $1 AND status = 'queued'", [projectId]);
      const result = await client.query('INSERT INTO deletion_requests (project_id, requested_by) VALUES ($1, $2) RETURNING id, status', [projectId, userId]);
      await client.query('UPDATE projects SET deleted_at = NOW() WHERE id = $1', [projectId]);
      await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
        VALUES ($1, $2, 'project.deletion_requested', 'project', $1)`, [projectId, userId]);
      await client.query('COMMIT'); return result.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async deletionStatus(user: AuthenticatedUser, requestId: string) {
    const client = await this.database.connect();
    try {
      const userId = await this.userId(client, user);
      const result = await client.query(
        `SELECT id, project_id AS "projectId", status, attempts, failure_code AS "failureCode",
         created_at AS "createdAt", completed_at AS "completedAt" FROM deletion_requests WHERE id = $1 AND requested_by = $2`, [requestId, userId],
      );
      if (!result.rows[0]) throw new NotFoundException('Deletion request not found'); return result.rows[0];
    } finally { client.release(); }
  }

  async exportProject(user: AuthenticatedUser, projectId: string) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.userId(client, user); const project = await this.project(client, userId, projectId, true);
      const plans = await client.query('SELECT id, name, source_type, status, created_at FROM test_plans WHERE project_id = $1', [projectId]);
      const versions = await client.query('SELECT pv.* FROM plan_versions pv JOIN test_plans p ON p.id = pv.plan_id WHERE p.project_id = $1', [projectId]);
      const runs = await client.query('SELECT id, status, created_at, started_at, completed_at, failure_code FROM test_runs WHERE project_id = $1', [projectId]);
      const summaries = await client.query('SELECT s.* FROM run_summaries s JOIN test_runs r ON r.id = s.run_id WHERE r.project_id = $1', [projectId]);
      const artifacts = await client.query<ArtifactRow>("SELECT * FROM artifacts WHERE project_id = $1 AND status = 'available' AND deleted_at IS NULL AND kind <> 'export'", [projectId]);
      const maximum = positiveSetting(this.config, 'MAX_EXPORT_BYTES', 67108864);
      const files = [];
      let total = 0;
      for (const artifact of artifacts.rows) {
        total += Number(artifact.size_bytes);
        if (total > maximum / 2) throw new ConflictException('Project export exceeds the configured size limit');
        const content = await this.storage.get(artifact.object_key);
        if (createHash('sha256').update(content).digest('hex') !== artifact.sha256) throw new ConflictException('Artifact integrity verification failed');
        files.push({ id: artifact.id, kind: artifact.kind, sha256: artifact.sha256, contentType: artifact.content_type, contentBase64: content.toString('base64') });
      }
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, project, plans: plans.rows, versions: versions.rows,
        runs: runs.rows, summaries: summaries.rows, artifacts: files }));
      if (bytes.length > maximum) throw new ConflictException('Project export exceeds the configured size limit');
      const sha = createHash('sha256').update(bytes).digest('hex'); const exportId = randomUUID();
      const key = `${projectId}/${exportId}/export-${sha}.json`;
      // Persist reservation first, then hold the project lock during object I/O.
      const artifact = await client.query<{ id: string }>(`INSERT INTO artifacts
        (id, project_id, kind, object_key, sha256, size_bytes, content_type)
        VALUES ($1, $2, 'export', $3, $4, $5, 'application/json') RETURNING id`, [exportId, projectId, key, sha, bytes.length]);
      await client.query('COMMIT'); await client.query('BEGIN'); await this.project(client, userId, projectId, true);
      await this.storage.put(key, bytes, 'application/json');
      await client.query("UPDATE artifacts SET status = 'available' WHERE id = $1", [exportId]);
      await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
        VALUES ($1, $2, 'project.export_created', 'artifact', $3)`, [projectId, userId, exportId]);
      await client.query('COMMIT'); return { projectId, artifactId: artifact.rows[0].id, format: 'json', sha256: sha, sizeBytes: bytes.length };
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }
}
