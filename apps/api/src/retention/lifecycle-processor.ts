import { ConfigService } from '@nestjs/config';
import { rm } from 'node:fs/promises';
import { ArtifactStorage } from '../artifacts/artifact-storage';
import { SqlClient, SqlDatabase } from '../runs/run-domain';
import { checkedStagingDirectory } from '../results/result-pipeline';

export interface EmailSender { send(to: string, subject: string, message: string, idempotencyKey: string): Promise<void> }
export class UnconfiguredEmailSender implements EmailSender {
  async send(): Promise<void> { throw new Error('email_provider_not_configured'); }
}

export class LifecycleProcessor {
  constructor(private readonly database: SqlDatabase, private readonly storage: ArtifactStorage,
    private readonly config: ConfigService, private readonly hostId: string,
    private readonly email: EmailSender = new UnconfiguredEmailSender()) {}

  async deleteProjectOne(): Promise<boolean> {
    const client = await this.database.connect();
    let requestId: string | undefined;
    try {
      await client.query('BEGIN');
      const request = await client.query<{ id: string; project_id: string; requested_by: string }>(
        `SELECT * FROM deletion_requests WHERE status <> 'completed' AND next_attempt_at <= NOW()
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!request.rows[0]) { await client.query('COMMIT'); return false; }
      const job = request.rows[0]; requestId = job.id;
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [job.project_id]);
      const sources = await client.query<{ run_id: string; worker_host_id: string; source_directory: string }>(
        `SELECT j.run_id, j.worker_host_id, j.source_directory FROM result_jobs j JOIN test_runs r ON r.id = j.run_id
         WHERE r.project_id = $1 AND j.source_directory IS NOT NULL`, [job.project_id],
      );
      for (const source of sources.rows) {
        if (source.worker_host_id !== this.hostId) throw new Error('staging_cleanup_pending');
        try {
          const path = await checkedStagingDirectory(this.config, source.source_directory, source.run_id);
          await rm(path, { recursive: true, force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await client.query('UPDATE result_jobs SET source_directory = NULL WHERE run_id = $1', [source.run_id]);
      }
      const artifacts = await client.query<{ id: string; object_key: string }>(
        "SELECT id, object_key FROM artifacts WHERE project_id = $1 AND status <> 'deleted'", [job.project_id],
      );
      for (const artifact of artifacts.rows) {
        await this.storage.delete(artifact.object_key);
        await client.query("UPDATE artifacts SET status = 'deleted', deleted_at = NOW() WHERE id = $1", [artifact.id]);
      }
      await this.tombstoneRuns(client, 'project_id', job.project_id);
      await client.query('DELETE FROM artifacts WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM test_runs WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM test_plans WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM targets WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM retention_notifications WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM retention_batches WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM retention_policies WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM project_sla_policies WHERE project_id = $1', [job.project_id]);
      await client.query('DELETE FROM project_members WHERE project_id = $1', [job.project_id]);
      await client.query("UPDATE projects SET name = '[deleted]', updated_at = NOW() WHERE id = $1", [job.project_id]);
      await client.query("UPDATE audit_events SET details_json = '{}'::JSONB WHERE project_id = $1", [job.project_id]);
      await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id)
        VALUES ($1, $2, 'project.deleted', 'project', $1)`, [job.project_id, job.requested_by]);
      await client.query("UPDATE deletion_requests SET status = 'completed', completed_at = NOW(), failure_code = NULL WHERE id = $1", [requestId]);
      await client.query('COMMIT'); return true;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!requestId) throw error;
      const code = error instanceof Error && error.message === 'staging_cleanup_pending' ? error.message : 'artifact_deletion_failed';
      await client.query(`UPDATE deletion_requests SET status = 'retrying', attempts = attempts + 1,
        failure_code = $2, next_attempt_at = NOW() + LEAST(300, POWER(2, LEAST(attempts + 1, 9))) * INTERVAL '1 second' WHERE id = $1`, [requestId, code]);
      return true;
    } finally { client.release(); }
  }

  private async tombstoneRuns(client: SqlClient, field: 'project_id' | 'id', id: string) {
    await client.query(`INSERT INTO run_idempotency_tombstones (requested_by, idempotency_key, run_id)
      SELECT requested_by, idempotency_key, id FROM test_runs WHERE ${field} = $1 ON CONFLICT DO NOTHING`, [id]);
  }

  async scheduleNoticeOne(): Promise<boolean> {
    if (this.config.get<string>('AUTOMATIC_RETENTION_APPROVED') !== 'true') return false;
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{ id: string; project_id: string; completed_at: Date; notice_days: number;
        notification_channels: string[]; notification_email: string | null }>(
        `SELECT r.id, r.project_id, r.completed_at, rp.notice_days, rp.notification_channels, rp.notification_email
         FROM test_runs r JOIN retention_policies rp ON rp.project_id = r.project_id
         JOIN projects p ON p.id = r.project_id WHERE r.completed_at IS NOT NULL AND p.deleted_at IS NULL
         AND rp.deletion_mode = 'automatic_after_notice' AND rp.notice_days IS NOT NULL
         AND r.completed_at + (30 - rp.notice_days) * INTERVAL '1 day' <= NOW()
         AND NOT EXISTS (SELECT 1 FROM retention_batches b WHERE b.run_id = r.id)
         ORDER BY r.completed_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
      );
      if (!due.rows[0]) { await client.query('COMMIT'); return false; }
      const run = due.rows[0];
      const batch = await client.query<{ id: string; scheduled_deletion_at: Date }>(
        `INSERT INTO retention_batches (project_id, run_id, scheduled_deletion_at, notice_days, required_channels)
         VALUES ($1, $2, GREATEST($3::TIMESTAMPTZ + INTERVAL '30 days', NOW() + $4::INTEGER * INTERVAL '1 day'), $4, $5)
         RETURNING id, scheduled_deletion_at`, [run.project_id, run.id, run.completed_at, run.notice_days, run.notification_channels],
      );
      const members = await client.query<{ user_id: string }>(
        'SELECT pm.user_id FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 AND u.disabled_at IS NULL', [run.project_id],
      );
      for (const member of members.rows) for (const channel of run.notification_channels) {
        await client.query(`INSERT INTO retention_notifications (project_id, batch_id, recipient_user_id, channel,
          message, scheduled_deletion_at, notified_at, status, recipient_email)
          VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'in_app' THEN NOW() ELSE NULL END,
            CASE WHEN $4 = 'in_app' THEN 'delivered' ELSE 'pending' END, $7)`,
          [run.project_id, batch.rows[0].id, member.user_id, channel,
            `Run ${run.id} and its artifacts are scheduled for deletion. Export or download your data before ${batch.rows[0].scheduled_deletion_at.toISOString()}.`,
            batch.rows[0].scheduled_deletion_at, channel === 'email' ? run.notification_email : null]);
      }
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async deliverEmailOne(): Promise<boolean> {
    const client = await this.database.connect();
    let id: string | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; recipient_email: string | null; message: string }>(
        `SELECT n.* FROM retention_notifications n JOIN projects p ON p.id = n.project_id
         WHERE n.channel = 'email' AND n.status = 'pending' AND n.next_attempt_at <= NOW() AND p.deleted_at IS NULL
         ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
      );
      const notification = result.rows[0];
      if (!notification) { await client.query('COMMIT'); return false; }
      id = notification.id;
      if (!notification.recipient_email) throw new Error('email_recipient_missing');
      await this.email.send(notification.recipient_email, 'Upcoming performance-test data deletion', notification.message, notification.id);
      await client.query("UPDATE retention_notifications SET status = 'delivered', notified_at = NOW(), attempts = attempts + 1 WHERE id = $1", [id]);
      await client.query('COMMIT'); return true;
    } catch {
      await client.query('ROLLBACK');
      if (id) await client.query(`UPDATE retention_notifications SET attempts = attempts + 1,
        status = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = NOW() + LEAST(300, POWER(2, attempts + 1)) * INTERVAL '1 second' WHERE id = $1`, [id]);
      return !!id;
    } finally { client.release(); }
  }

  async deleteExpiredOne(): Promise<boolean> {
    if (this.config.get<string>('AUTOMATIC_RETENTION_APPROVED') !== 'true') return false;
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; project_id: string; run_id: string }>(
        `SELECT b.id, b.project_id, b.run_id FROM retention_batches b
         JOIN projects p ON p.id = b.project_id JOIN retention_policies rp ON rp.project_id = b.project_id
         WHERE b.status = 'notified' AND p.deleted_at IS NULL AND rp.deletion_mode = 'automatic_after_notice'
         AND b.scheduled_deletion_at <= NOW()
         AND EXISTS (SELECT 1 FROM retention_notifications n WHERE n.batch_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM unnest(b.required_channels) AS required(channel)
           WHERE NOT EXISTS (SELECT 1 FROM retention_notifications n WHERE n.batch_id = b.id AND n.channel = required.channel))
         AND NOT EXISTS (SELECT 1 FROM retention_notifications n WHERE n.batch_id = b.id AND
           (n.status <> 'delivered' OR n.notified_at IS NULL OR n.notified_at + b.notice_days * INTERVAL '1 day' > NOW()))
         AND NOT EXISTS (SELECT 1 FROM result_jobs j WHERE j.run_id = b.run_id AND j.source_directory IS NOT NULL)
         ORDER BY b.scheduled_deletion_at LIMIT 1 FOR UPDATE OF p, b SKIP LOCKED`,
      );
      const batch = result.rows[0];
      if (!batch) { await client.query('COMMIT'); return false; }
      const artifacts = await client.query<{ id: string; object_key: string }>('SELECT id, object_key FROM artifacts WHERE run_id = $1', [batch.run_id]);
      for (const artifact of artifacts.rows) { await this.storage.delete(artifact.object_key); await client.query('DELETE FROM artifacts WHERE id = $1', [artifact.id]); }
      await this.tombstoneRuns(client, 'id', batch.run_id);
      await client.query('DELETE FROM test_runs WHERE id = $1', [batch.run_id]);
      await client.query("UPDATE retention_batches SET status = 'completed', completed_at = NOW() WHERE id = $1", [batch.id]);
      await client.query(`INSERT INTO audit_events (project_id, action, resource_type, resource_id) VALUES ($1, 'run.retention_deleted', 'run', $2)`,
        [batch.project_id, batch.run_id]);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }
}
