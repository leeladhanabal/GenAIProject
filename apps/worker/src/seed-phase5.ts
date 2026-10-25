import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_MOCK_USER, LocalUserGuard } from '../../api/src/auth/local-user.guard';
import { DatabaseService } from '../../api/src/database/database.service';
import { renderScript } from '../../api/src/plans/planning-content';
import { stagingRoot } from '../../api/src/results/result-pipeline';
import { SqlDatabase } from '../../api/src/runs/run-domain';

// Explicit local-only fixture command. Records are marked synthetic, its plan
// is archived, and its target is disabled: it cannot authorize real load.
export async function seedPhase5Fixture(database: SqlDatabase, config: ConfigService) {
  new LocalUserGuard(config);
  const hostId = config.get<string>('WORKER_HOST_ID') ?? 'local-docker';
  const projectId = randomUUID(); const targetId = randomUUID(); const planId = randomUUID();
  const versionId = randomUUID(); const runId = randomUUID(); const notificationId = randomUUID();
  const definition = { targetId, baseUrl: 'https://fixture.example.test/', workload: { virtualUsers: 1, durationSeconds: 10 },
    scenarios: [{ name: 'Synthetic fixture; no load executed', method: 'GET', path: '/health', expectedStatus: 200 }] };
  const directory = join(stagingRoot(config), runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const summary = { fixture: true, metrics: {
    http_reqs: { values: { count: 20, rate: 2 } }, http_req_failed: { values: { rate: 0.05 } },
    checks: { values: { rate: 0.95 } }, http_req_duration: { values: { avg: 100, med: 100, 'p(95)': 100, 'p(99)': 100 } },
  }, state: { testRunDurationMs: 10000 } };
  const end = Date.now();
  const points = Array.from({ length: 20 }, (_, index) => ({ type: 'Point', metric: 'http_req_duration',
    data: { time: new Date(end - 10000 + index * 500).toISOString(), value: 100,
      tags: { fixture: 'true', status: index === 19 ? '500' : '200' } } }));
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary), { mode: 0o600 });
  await writeFile(join(directory, 'results.ndjson'), points.map((point) => JSON.stringify(point)).join('\n') + '\n', { mode: 0o600 });
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(`INSERT INTO users (oidc_issuer, oidc_subject, email, display_name)
      VALUES ($1, $2, $3, $4) ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET display_name = EXCLUDED.display_name
      WHERE users.disabled_at IS NULL RETURNING id`,
      [LOCAL_MOCK_USER.issuer, LOCAL_MOCK_USER.subject, LOCAL_MOCK_USER.email, LOCAL_MOCK_USER.displayName]);
    if (!user.rows[0]) throw new Error('Local fixture user is disabled');
    const userId = user.rows[0].id;
    await client.query('INSERT INTO projects (id, name, owner_user_id) VALUES ($1, $2, $3)', [projectId, 'Phase 5 synthetic fixture', userId]);
    await client.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)', [projectId, userId]);
    await client.query(`INSERT INTO targets (id, project_id, name, base_url, approved_domains, authorization_confirmed_by, disabled_at)
      VALUES ($1, $2, 'Disabled synthetic fixture', $3, ARRAY['fixture.example.test'], $4, NOW())`, [targetId, projectId, definition.baseUrl, userId]);
    await client.query(`INSERT INTO test_plans (id, project_id, created_by, name, source_type, status)
      VALUES ($1, $2, $3, 'Synthetic fixture; not runnable', 'fixture', 'archived')`, [planId, projectId, userId]);
    await client.query(`INSERT INTO plan_versions (id, plan_id, version, workload_json, requirements_text, created_by, script_definition_json)
      VALUES ($1, $2, 1, $3::JSONB, 'Synthetic results only; no test was executed.', $4, $5::JSONB)`,
      [versionId, planId, JSON.stringify(definition.workload), userId, JSON.stringify(definition)]);
    await client.query(`INSERT INTO test_runs (id, project_id, plan_version_id, target_id, requested_by, status,
      idempotency_key, request_sha256, script_sha256, script_definition_json, limits_json, worker_host_id,
      result_status, created_at, queued_at, started_at, completed_at)
      VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9::JSONB, $10::JSONB, $11,
        'pending', NOW() - INTERVAL '11 seconds', NOW() - INTERVAL '11 seconds', NOW() - INTERVAL '10 seconds', NOW())`,
      [runId, projectId, versionId, targetId, userId, randomUUID(), createHash('sha256').update(`fixture:${runId}`).digest('hex'),
        renderScript(definition).sha256, JSON.stringify(definition), JSON.stringify({ maxVirtualUsers: 1, maxDurationSeconds: 10,
          maxConcurrentRuns: 5, maxRequestsPerSecond: 2, maxRequestsPerRun: 20 }), hostId]);
    await client.query(`INSERT INTO result_jobs (run_id, worker_host_id, source_directory, source_type) VALUES ($1, $2, $3, 'fixture')`, [runId, hostId, directory]);
    await client.query(`INSERT INTO retention_notifications (id, project_id, recipient_user_id, channel, message, status, notified_at)
      VALUES ($1, $2, $3, 'in_app', 'Synthetic Phase 5 notification. This fixture does not schedule deletion.', 'delivered', NOW())`, [notificationId, projectId, userId]);
    await client.query(`INSERT INTO audit_events (project_id, actor_user_id, action, resource_type, resource_id, details_json)
      VALUES ($1, $2, 'fixture.created', 'run', $3, '{"source":"fixture","loadExecuted":false}'::JSONB)`, [projectId, userId, runId]);
    await client.query('COMMIT');
    return { projectId, planId, runId, notificationId, source: 'fixture', loadExecuted: false };
  } catch (error) { await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

if (require.main === module) {
  const database = new DatabaseService();
  void seedPhase5Fixture(database, new ConfigService()).then((ids) => console.log(JSON.stringify(ids, null, 2)))
    .catch(() => { console.error('Fixture creation failed. Check local mode, database migrations, and staging configuration.'); process.exitCode = 1; })
    .finally(() => database.onModuleDestroy());
}
