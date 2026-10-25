import { SqlDatabase } from '../../api/src/runs/run-domain';

export interface RunPublisher { publish(runId: string): Promise<void> }

export class OutboxDispatcher {
  constructor(private readonly database: SqlDatabase, private readonly publisher: RunPublisher) {}

  async dispatchOne(): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ run_id: string }>(
        `SELECT o.run_id FROM run_outbox o JOIN test_runs r ON r.id = o.run_id
         WHERE r.status = 'queued' AND (o.last_dispatched_at IS NULL OR o.last_dispatched_at < NOW() - INTERVAL '10 seconds')
         ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      );
      const runId = result.rows[0]?.run_id;
      if (!runId) { await client.query('COMMIT'); return false; }
      // Approval/run/outbox committed in the API before any job is published.
      // Queue ID deduplication makes a publish followed by DB rollback safe.
      await this.publisher.publish(runId);
      await client.query(
        'UPDATE run_outbox SET last_dispatched_at = NOW(), dispatch_attempts = dispatch_attempts + 1 WHERE run_id = $1', [runId],
      );
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }
}
