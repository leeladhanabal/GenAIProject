import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { EmbeddedPostgres } from '../../../../tests/support/embedded-postgres';
import { seedPhase5Fixture } from '../../../worker/src/seed-phase5';
import { LocalUserGuard, LOCAL_MOCK_USER } from '../auth/local-user.guard';
import { LocalArtifactStorage } from '../artifacts/artifact-storage';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { DatabaseService } from '../database/database.service';
import { LifecycleProcessor } from '../retention/lifecycle-processor';
import { RunsController } from '../runs/runs.controller';
import { RunsService } from '../runs/runs.service';
import { Phase5Controller } from './phase5.controller';
import { Phase5Service } from './phase5.service';
import { ResultPipeline } from './result-pipeline';

jest.setTimeout(30000);

describe('Phase 5 results and lifecycle integration (real embedded PostgreSQL/private files)', () => {
  let database: EmbeddedPostgres;
  let config: ConfigService;
  let root: string;
  let storage: LocalArtifactStorage;
  let service: Phase5Service;
  let pipeline: ResultPipeline;
  let lifecycle: LifecycleProcessor;
  let app: INestApplication;
  let ids: Awaited<ReturnType<typeof seedPhase5Fixture>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'phase5-integration-'));
    config = new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: 'test', WORKER_HOST_ID: 'phase5-test',
      ARTIFACTS_DIR: join(root, 'artifacts'), RESULT_STAGING_DIR: join(root, 'staging'),
      ARTIFACT_SIGNING_SECRET: 'test-only-signing-secret-with-at-least-32-bytes', AUTOMATIC_RETENTION_APPROVED: 'false',
      MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60', MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '100' });
    database = new EmbeddedPostgres(); await database.migrate();
    storage = new LocalArtifactStorage(join(root, 'artifacts'));
    service = new Phase5Service(database as unknown as DatabaseService, config, storage);
    pipeline = new ResultPipeline(database, storage, config, 'phase5-test');
    lifecycle = new LifecycleProcessor(database, storage, config, 'phase5-test');
    const module = await Test.createTestingModule({ controllers: [Phase5Controller, RunsController], providers: [LocalUserGuard,
      { provide: ConfigService, useValue: config }, { provide: Phase5Service, useValue: service },
      { provide: RunsService, useValue: new RunsService(database as unknown as DatabaseService, config) },
    ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new ApiExceptionFilter()); await app.init();
  });
  afterAll(async () => { await app?.close(); await database?.engine.close(); if (root) await rm(root, { recursive: true, force: true }); });
  beforeEach(async () => {
    jest.restoreAllMocks(); await database.engine.exec('TRUNCATE users CASCADE');
    await rm(join(root, 'artifacts'), { recursive: true, force: true });
    await rm(join(root, 'staging'), { recursive: true, force: true });
    ids = await seedPhase5Fixture(database, config);
  });

  async function ready() { expect(await pipeline.processOne()).toBe(true); }
  async function artifact() {
    await ready(); const rows = await database.query<{ id: string; object_key: string }>("SELECT id, object_key FROM artifacts WHERE run_id = $1 AND kind = 'report_json'", [ids.runId]);
    return rows.rows[0];
  }

  it('persists measured summaries, two reports, checksums, and five private artifacts without rerunning load', async () => {
    await ready();
    const result = await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}`).expect(200);
    expect(result.body.resultStatus).toBe('ready');
    expect(result.body.summary).toMatchObject({ source: 'fixture', requests: 20, errorRate: 0.05,
      latencyMs: { p95: 100 }, slaStatus: 'not_configured' });
    const reports = await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}/reports`).expect(200);
    expect(reports.body.items.map((row: { format: string }) => row.format)).toEqual(['html', 'json']);
    expect(JSON.stringify(reports.body)).not.toMatch(/object_key|download-link|token=/);
    const listed = await service.artifacts(LOCAL_MOCK_USER, ids.projectId); expect(listed.items).toHaveLength(5);
    expect(await pipeline.processOne()).toBe(false);
    expect((await database.query("SELECT 1 FROM audit_events WHERE action = 'fixture.created'")).rowCount).toBe(1);
  });

  it('issues an expiring signed link and serves the exact report bytes without user tokens', async () => {
    const file = await artifact();
    const link = await request(app.getHttpServer()).post(`/api/v1/artifacts/${file.id}/download-link`).expect(200);
    const url = new URL(link.body.url);
    const response = await request(app.getHttpServer()).get(url.pathname + url.search).expect(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.summary.source).toBe('fixture');
    expect(Buffer.from(await storage.get(file.object_key)).toString('utf8')).toContain(ids.runId);
    await request(app.getHttpServer()).get(`/api/v1/artifacts/${file.id}/content?token=bad`).expect(403);
    await request(app.getHttpServer()).get(url.pathname + url.search.slice(0, -1) + (url.search.endsWith('a') ? 'b' : 'a')).expect(403);
  });

  it('rejects an expired download capability', async () => {
    const file = await artifact(); const link = await service.downloadLink(LOCAL_MOCK_USER, file.id);
    const time = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
    await expect(service.download(LOCAL_MOCK_USER, file.id, new URL(link.url).searchParams.get('token')!)).rejects.toMatchObject({ status: 403 });
    time.mockRestore();
  });

  it('checks artifact integrity before sending bytes', async () => {
    const file = await artifact(); await storage.put(file.object_key, Buffer.from('tampered'), 'application/json');
    const link = await service.downloadLink(LOCAL_MOCK_USER, file.id);
    await expect(service.download(LOCAL_MOCK_USER, file.id, new URL(link.url).searchParams.get('token')!)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps storage reservations discoverable and retries only processing after an upload failure', async () => {
    const upload = jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    await pipeline.processOne();
    expect((await database.query('SELECT * FROM artifacts WHERE run_id = $1', [ids.runId])).rowCount).toBe(5);
    expect((await database.query('SELECT result_status FROM test_runs WHERE id = $1', [ids.runId])).rows[0].result_status).toBe('pending');
    upload.mockRestore(); await database.query('UPDATE result_jobs SET next_attempt_at = NOW()'); await ready();
    expect((await service.reports(LOCAL_MOCK_USER, ids.runId)).items).toHaveLength(2);
    expect((await database.query('SELECT id FROM test_runs')).rowCount).toBe(1);
  });

  it('bounds retries and allows explicit result retry without scheduling another load test', async () => {
    const upload = jest.spyOn(storage, 'put').mockRejectedValue(new Error('storage unavailable'));
    for (let index = 0; index < 5; index++) { await database.query('UPDATE result_jobs SET next_attempt_at = NOW()'); await pipeline.processOne(); }
    expect((await database.query('SELECT result_status FROM test_runs')).rows[0].result_status).toBe('failed');
    const retry = await request(app.getHttpServer()).post(`/api/v1/runs/${ids.runId}/results/retry`).expect(202);
    expect(retry.body.loadTestRerun).toBe(false); upload.mockRestore(); await ready();
    expect((await database.query('SELECT run_id FROM run_outbox')).rowCount).toBe(0);
  });

  it('rejects invalid summary input without inventing metrics', async () => {
    await writeFile(join(root, 'staging', ids.runId, 'summary.json'), '{"unexpected":true}');
    await pipeline.processOne();
    expect((await database.query('SELECT metrics_json FROM run_summaries')).rowCount).toBe(0);
    expect((await database.query('SELECT failure_code FROM result_jobs')).rows[0].failure_code).toBe('invalid_k6_summary');
  });

  it('creates a full JSON export with actual artifact bytes before deletion', async () => {
    await ready(); const exported = await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/exports`).expect(201);
    const link = await service.downloadLink(LOCAL_MOCK_USER, exported.body.artifactId);
    const bytes = await service.download(LOCAL_MOCK_USER, exported.body.artifactId, new URL(link.url).searchParams.get('token')!);
    const snapshot = JSON.parse(bytes.content.toString('utf8'));
    expect(snapshot.project.id).toBe(ids.projectId); expect(snapshot.artifacts).toHaveLength(5);
    expect(Buffer.from(snapshot.artifacts[0].contentBase64, 'base64').length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain('ARTIFACT_SIGNING_SECRET');
  });

  it('defaults to 30-day manual retention and does not schedule deletion without policy approval', async () => {
    await database.query("UPDATE test_runs SET completed_at = NOW() - INTERVAL '40 days'");
    const policy = await request(app.getHttpServer()).get(`/api/v1/projects/${ids.projectId}/retention`).expect(200);
    expect(policy.body).toMatchObject({ retentionDays: 30, noticeDays: 2, deletionMode: 'manual', automaticDeletionEnabled: false });
    expect(await lifecycle.scheduleNoticeOne()).toBe(false); expect(await lifecycle.deleteExpiredOne()).toBe(false);
    await request(app.getHttpServer()).put(`/api/v1/projects/${ids.projectId}/retention`)
      .send({ retentionDays: 30, deletionMode: 'automatic_after_notice', noticeDays: 3, channels: ['in_app'] }).expect(409);
  });

  it('reads in-app notices and marks them read idempotently', async () => {
    const listed = await request(app.getHttpServer()).get(`/api/v1/projects/${ids.projectId}/notifications`).expect(200);
    expect(listed.body.items[0].message).toContain('Synthetic');
    const first = await request(app.getHttpServer()).post(`/api/v1/notifications/${ids.notificationId}/read`).expect(200);
    const second = await request(app.getHttpServer()).post(`/api/v1/notifications/${ids.notificationId}/read`).expect(200);
    expect(second.body.readAt).toBe(first.body.readAt);
  });

  it('does not delete on missing or false explicit confirmation', async () => {
    await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/deletion-requests`).send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/deletion-requests`).send({ confirmed: false }).expect(400);
    expect((await database.query('SELECT id FROM deletion_requests')).rowCount).toBe(0);
  });

  it('deletes all objects and project data, revokes links, and retains minimal audit/status tombstones', async () => {
    const file = await artifact(); const link = await service.downloadLink(LOCAL_MOCK_USER, file.id);
    const accepted = await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/deletion-requests`).send({ confirmed: true }).expect(202);
    await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}`).expect(404);
    expect(await lifecycle.deleteProjectOne()).toBe(true);
    expect((await service.deletionStatus(LOCAL_MOCK_USER, accepted.body.id)).status).toBe('completed');
    await expect(storage.get(file.object_key)).rejects.toThrow();
    await expect(service.download(LOCAL_MOCK_USER, file.id, new URL(link.url).searchParams.get('token')!)).rejects.toMatchObject({ status: 404 });
    for (const table of ['test_runs', 'test_plans', 'targets', 'artifacts', 'reports', 'run_summaries']) {
      expect((await database.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
    expect((await database.query('SELECT name FROM projects')).rows[0].name).toBe('[deleted]');
    expect((await database.query('SELECT 1 FROM audit_events')).rowCount).toBeGreaterThan(0);
    expect((await database.query('SELECT 1 FROM run_idempotency_tombstones')).rowCount).toBe(1);
  });

  it('never reports deletion complete when object deletion fails; a later retry finishes safely', async () => {
    await ready(); const accepted = await service.requestDeletion(LOCAL_MOCK_USER, ids.projectId, true);
    const remove = jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('storage offline'));
    await lifecycle.deleteProjectOne(); expect((await service.deletionStatus(LOCAL_MOCK_USER, accepted.id)).status).toBe('retrying');
    expect((await database.query('SELECT id FROM artifacts')).rowCount).toBe(5);
    remove.mockRestore(); await database.query('UPDATE deletion_requests SET next_attempt_at = NOW()'); await lifecycle.deleteProjectOne();
    expect((await service.deletionStatus(LOCAL_MOCK_USER, accepted.id)).status).toBe('completed');
  });

  it('cleans unprocessed staging data before confirming project deletion', async () => {
    const accepted = await service.requestDeletion(LOCAL_MOCK_USER, ids.projectId, true); await lifecycle.deleteProjectOne();
    expect((await service.deletionStatus(LOCAL_MOCK_USER, accepted.id)).status).toBe('completed');
    await expect(access(join(root, 'staging', ids.runId))).rejects.toThrow();
  });

  it('blocks deletion while a run is still executing', async () => {
    await database.query("UPDATE test_runs SET status = 'running', execution_token = gen_random_uuid() WHERE id = $1", [ids.runId]);
    await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/deletion-requests`).send({ confirmed: true }).expect(409);
  });

  it('enforces project boundaries for reports, exports, links, and deletion', async () => {
    const file = await artifact();
    await database.query('DELETE FROM project_members WHERE project_id = $1', [ids.projectId]);
    await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}/reports`).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/artifacts/${file.id}/download-link`).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/exports`).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/projects/${ids.projectId}/deletion-requests`).send({ confirmed: true }).expect(404);
  });

  it('rejects malformed SLA thresholds and exposes policy for future approval snapshots', async () => {
    await request(app.getHttpServer()).put(`/api/v1/projects/${ids.projectId}/sla`).send({ p95ResponseTimeMs: null }).expect(400);
    const updated = await request(app.getHttpServer()).put(`/api/v1/projects/${ids.projectId}/sla`)
      .send({ p95ResponseTimeMs: 250, maxErrorRate: 0.01 }).expect(200);
    expect(updated.body.appliesTo).toBe('future_run_approvals');
    expect((await service.sla(LOCAL_MOCK_USER, ids.projectId)).thresholds).toEqual({ p95ResponseTimeMs: 250, maxErrorRate: 0.01 });
  });

  async function approveTestRetention(channels = ['in_app']) {
    await database.query("UPDATE test_runs SET completed_at = NOW() - INTERVAL '31 days'");
    await database.query(`INSERT INTO retention_policies (project_id, notice_days, deletion_mode, notification_channels, notification_email)
      VALUES ($1, 3, 'automatic_after_notice', $2, 'fixture-recipient@example.test')`, [ids.projectId, channels]);
    const approved = new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: 'test', AUTOMATIC_RETENTION_APPROVED: 'true',
      RESULT_STAGING_DIR: join(root, 'staging') });
    return new LifecycleProcessor(database, storage, approved, 'phase5-test');
  }

  it('gives a full advance-notice period even when scheduling is late, then removes run data consistently', async () => {
    const approved = await approveTestRetention(); await ready();
    expect(await approved.scheduleNoticeOne()).toBe(true);
    const batch = (await database.query<{ scheduled_deletion_at: Date }>('SELECT scheduled_deletion_at FROM retention_batches')).rows[0];
    expect(batch.scheduled_deletion_at.getTime()).toBeGreaterThan(Date.now() + 2.99 * 86400000);
    expect(await approved.deleteExpiredOne()).toBe(false);
    await database.query("UPDATE retention_batches SET scheduled_deletion_at = NOW() - INTERVAL '1 day'");
    expect(await approved.deleteExpiredOne()).toBe(false); // Notice has not aged enough.
    await database.query("UPDATE retention_notifications SET notified_at = NOW() - INTERVAL '4 days' WHERE batch_id IS NOT NULL");
    expect(await approved.deleteExpiredOne()).toBe(true);
    expect((await database.query('SELECT id FROM test_runs')).rowCount).toBe(0);
    expect((await database.query('SELECT id FROM artifacts')).rowCount).toBe(0);
    expect((await database.query('SELECT id FROM test_plans')).rowCount).toBe(1);
    expect((await database.query('SELECT 1 FROM run_idempotency_tombstones')).rowCount).toBe(1);
  });

  it('blocks automatic deletion if a required email notice has not been delivered', async () => {
    const approved = await approveTestRetention(['in_app', 'email']); await ready();
    await approved.scheduleNoticeOne();
    for (let index = 0; index < 5; index++) {
      await database.query('UPDATE retention_notifications SET next_attempt_at = NOW()');
      await approved.deliverEmailOne(); // Unconfigured adapter never reports delivery.
    }
    expect((await database.query("SELECT status FROM retention_notifications WHERE channel = 'email'")).rows[0].status).toBe('failed');
    await database.query("UPDATE retention_batches SET scheduled_deletion_at = NOW() - INTERVAL '1 day'");
    await database.query("UPDATE retention_notifications SET notified_at = NOW() - INTERVAL '4 days' WHERE channel = 'in_app'");
    expect(await approved.deleteExpiredOne()).toBe(false);
  });

  it('retries a transient email failure without marking the notice delivered early', async () => {
    const approved = await approveTestRetention(['in_app', 'email']); await ready(); await approved.scheduleNoticeOne();
    const send = jest.fn().mockRejectedValueOnce(new Error('temporary delivery failure')).mockResolvedValue(undefined);
    const emailProcessor = new LifecycleProcessor(database, storage, config, 'phase5-test', { send });
    await emailProcessor.deliverEmailOne();
    expect((await database.query("SELECT status FROM retention_notifications WHERE channel = 'email'")).rows[0].status).toBe('pending');
    await database.query('UPDATE retention_notifications SET next_attempt_at = NOW()');
    await emailProcessor.deliverEmailOne();
    expect((await database.query("SELECT status FROM retention_notifications WHERE channel = 'email'")).rows[0].status).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not treat partial results as a completed passing SLA evaluation', async () => {
    await database.query("UPDATE test_runs SET status = 'failed', failure_code = 'worker_lost', sla_thresholds_json = '{\"p95ResponseTimeMs\":200}'::JSONB");
    await ready();
    const result = await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}`).expect(200);
    expect(result.body.summary.slaStatus).toBe('incomplete');
  });

  it('preserves ready results when private staging cleanup fails', async () => {
    await ready();
    const directory = join(root, 'staging', ids.runId);
    await mkdir(directory, { recursive: true });
    await database.query('UPDATE result_jobs SET source_directory = $2 WHERE run_id = $1', [ids.runId, directory + '-invalid']);
    await pipeline.processOne();
    expect((await database.query('SELECT result_status FROM test_runs')).rows[0].result_status).toBe('ready');
    expect((await database.query('SELECT status FROM result_jobs')).rows[0].status).toBe('completed');
  });

  it('rejects a reviewed script checksum mismatch during processing', async () => {
    await database.query('UPDATE test_runs SET script_sha256 = $1', ['0'.repeat(64)]);
    await pipeline.processOne();
    expect((await database.query('SELECT failure_code FROM result_jobs')).rows[0].failure_code).toBe('artifact_content_conflict');
    expect((await database.query('SELECT id FROM artifacts')).rowCount).toBe(0);
  });

  it('does not delete when a required notification channel has no record', async () => {
    const approved = await approveTestRetention(['in_app', 'email']); await ready(); await approved.scheduleNoticeOne();
    await database.query("DELETE FROM retention_notifications WHERE channel = 'email'");
    await database.query("UPDATE retention_batches SET scheduled_deletion_at = NOW() - INTERVAL '1 day'");
    await database.query("UPDATE retention_notifications SET notified_at = NOW() - INTERVAL '4 days' WHERE batch_id IS NOT NULL");
    expect(await approved.deleteExpiredOne()).toBe(false);
  });

  it('returns measured deltas only after both runs have processed results', async () => {
    await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}/comparison?baselineRunId=${ids.runId}`).expect(409);
    await ready();
    const compared = await request(app.getHttpServer()).get(`/api/v1/runs/${ids.runId}/comparison?baselineRunId=${ids.runId}`).expect(200);
    expect(compared.body).toMatchObject({ comparable: true, deltas: { requestsPerSecond: 0, errorRate: 0, p95ResponseTimeMs: 0 } });
  });
});
