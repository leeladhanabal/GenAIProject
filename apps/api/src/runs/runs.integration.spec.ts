import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { EmbeddedPostgres } from '../../../../tests/support/embedded-postgres';
import { RunStore } from '../../../worker/src/run-store';
import { RunProcessor } from '../../../worker/src/run-processor';
import { OutboxDispatcher } from '../../../worker/src/outbox-dispatcher';
import { K6Runtime, RuntimeNotStoppedError, runtimeWrapper } from '../../../worker/src/docker-k6-runtime';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { LOCAL_MOCK_USER, LocalUserGuard } from '../auth/local-user.guard';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { DatabaseService } from '../database/database.service';
import { GroqPlanningAdapter } from '../plans/groq-planning.adapter';
import { PlansService } from '../plans/plans.service';
import { PlansController } from '../plans/plans.controller';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { CreateRunDto } from './dto/create-run.dto';
import { readRunLimits } from './run-domain';

jest.setTimeout(30000);

const user: AuthenticatedUser = { ...LOCAL_MOCK_USER };
const outsider: AuthenticatedUser = { ...user, subject: 'outsider', email: 'outsider@example.test' };
const projectId = '6b7f8669-71c1-4bba-96dd-ef1e471442ae';
const targetId = '3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00';
const userId = '11111111-1111-4111-8111-111111111111';
const config = new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: 'test', MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60',
  MAX_CONCURRENT_RUNS: '5', MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10' });
const input: CreateRunDto = { targetId, planVersion: 1,
  workload: { virtualUsers: 1, durationSeconds: 1 }, authorizationConfirmed: true, approved: true };

describe('Phase 4 PostgreSQL/API/worker integration', () => {
  let database: EmbeddedPostgres;
  let plans: PlansService;
  let runs: RunsService;
  let store: RunStore;
  let planId: string;
  let app: INestApplication;

  beforeAll(async () => {
    database = new EmbeddedPostgres(); await database.migrate();
    runs = new RunsService(database as unknown as DatabaseService, config);
    plans = new PlansService(database as unknown as DatabaseService, config,
      new GroqPlanningAdapter(new ConfigService({ GROQ_API_KEY: '' })));
    store = new RunStore(database);
    const module = await Test.createTestingModule({ controllers: [RunsController, ProjectsController, PlansController],
      providers: [LocalUserGuard, { provide: ConfigService, useValue: config },
        { provide: RunsService, useValue: runs }, { provide: PlansService, useValue: plans },
        { provide: ProjectsService, useValue: new ProjectsService(database as unknown as DatabaseService) }],
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new ApiExceptionFilter()); await app.init();
  });

  afterAll(async () => { await app?.close(); await database?.engine.close(); });

  beforeEach(async () => {
    await database.engine.exec('TRUNCATE users CASCADE');
    await database.query('INSERT INTO users (id, oidc_issuer, oidc_subject, email) VALUES ($1, $2, $3, $4)',
      [userId, user.issuer, user.subject, user.email]);
    await database.query('INSERT INTO projects (id, name, owner_user_id) VALUES ($1, $2, $3)', [projectId, 'Fixture', userId]);
    await database.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)', [projectId, userId]);
    await database.query(`INSERT INTO targets (id, project_id, name, base_url, approved_domains, authorization_confirmed_by)
      VALUES ($1, $2, 'Fixture target', 'https://staging.example.test/', ARRAY['staging.example.test'], $3)`, [targetId, projectId, userId]);
    const plan = await plans.createPlan(user, projectId, { name: 'Fixture', requirementsText: 'GET /health must return 200',
      script: { targetId, workload: input.workload,
        scenarios: [{ name: 'Health', method: 'GET', path: '/health', expectedStatus: 200 }] } });
    planId = plan.id;
    await plans.reviewScript(user, planId, 1, { reviewed: true, sha256: plan.versions[0].script!.sha256 });
  });

  async function approvedRun() { return runs.create(user, planId, randomUUID(), input); }
  function runtime(): jest.Mocked<K6Runtime> {
    return { execute: jest.fn().mockResolvedValue({ exitCode: 0 }), stop: jest.fn().mockResolvedValue(true) };
  }

  it('snapshots SLA thresholds when approving and preserves them after policy changes', async () => {
    await database.query(`INSERT INTO project_sla_policies (project_id, thresholds_json)
      VALUES ($1, '{"p95ResponseTimeMs":250,"maxErrorRate":0.01}'::JSONB)`, [projectId]);
    const run = await approvedRun();
    await database.query("UPDATE project_sla_policies SET thresholds_json = '{}'::JSONB");
    const snapshot = await database.query('SELECT sla_thresholds_json FROM test_runs WHERE id = $1', [run.runId]);
    expect(snapshot.rows[0].sla_thresholds_json).toEqual({ p95ResponseTimeMs: 250, maxErrorRate: 0.01 });
  });

  it('never turns a deleted run idempotency key into another load approval', async () => {
    const key = randomUUID(); const run = await runs.create(user, planId, key, input);
    await database.query(`INSERT INTO run_idempotency_tombstones (requested_by, idempotency_key, run_id)
      VALUES ($1, $2, $3)`, [userId, key, run.runId]);
    await database.query('DELETE FROM test_runs WHERE id = $1', [run.runId]);
    await expect(runs.create(user, planId, key, input)).rejects.toMatchObject({ status: 410 });
    expect((await database.query('SELECT id FROM test_runs')).rowCount).toBe(0);
  });

  it('records staging output for cleanup when runtime attachment throws after capture starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase5-capture-failure-'));
    try {
      const run = await approvedRun(); const engine = runtime();
      const processorConfig = new ConfigService({ RESULT_STAGING_DIR: root, MAX_VIRTUAL_USERS: '10',
        MAX_DURATION_SECONDS: '60', MAX_CONCURRENT_RUNS: '5', MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10' });
      engine.execute.mockImplementation(async (claimed) => {
        await mkdir(join(root, claimed.id));
        await writeFile(join(root, claimed.id, 'results.ndjson'), '{"synthetic":true}\n');
        throw new Error('attachment failed after output was created');
      });
      const processor = new RunProcessor(store, engine, processorConfig, 'fixture-host', jest.fn().mockResolvedValue('93.184.216.34'));
      await processor.process(run.runId);
      expect((await runs.get(user, run.runId)).status).toBe('failed');
      const job = (await database.query('SELECT source_directory, status FROM result_jobs WHERE run_id = $1', [run.runId])).rows[0];
      expect(job).toEqual({ source_directory: join(root, run.runId), status: 'pending' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('commits approval, run snapshot, audit, and outbox before queue publication', async () => {
    const response = await request(app.getHttpServer()).post(`/api/v1/plans/${planId}/runs`)
      .set('Idempotency-Key', randomUUID()).send(input).expect(202);
    expect(response.body.status).toBe('queued'); expect(response.body.startedAt).toBeNull();
    expect(response.body.summary).toBeNull();
    expect((await database.query('SELECT * FROM run_outbox')).rowCount).toBe(1);
    expect((await database.query("SELECT * FROM audit_events WHERE action = 'run.approved'")).rowCount).toBe(1);
  });

  it('replays the same idempotency key and rejects conflicting reuse', async () => {
    const key = randomUUID(); const first = await runs.create(user, planId, key, input);
    const second = await runs.create(user, planId, key, input);
    expect(second.runId).toBe(first.runId);
    await expect(runs.create(user, planId, key, { ...input, planVersion: 2 })).rejects.toMatchObject({ status: 409 });
    expect((await database.query('SELECT * FROM test_runs')).rowCount).toBe(1);
    expect((await database.query('SELECT * FROM run_outbox')).rowCount).toBe(1);
  });

  it.each([
    { ...input, approved: false }, { ...input, authorizationConfirmed: false },
    { ...input, workload: { virtualUsers: '1', durationSeconds: 1 } },
    { ...input, workload: { virtualUsers: 1, durationSeconds: 1, rps: 999 } },
    { ...input, workload: null },
  ])('rejects missing approvals and malformed/unknown workload input: %p', async (body) => {
    await request(app.getHttpServer()).post(`/api/v1/plans/${planId}/runs`)
      .set('Idempotency-Key', randomUUID()).send(body).expect(400);
    expect((await database.query('SELECT * FROM test_runs')).rowCount).toBe(0);
  });

  it('accepts the fixed user without a token while requiring a valid idempotency key', async () => {
    await request(app.getHttpServer()).post(`/api/v1/plans/${planId}/runs`)
      .set('Idempotency-Key', randomUUID()).send(input).expect(202);
    await request(app.getHttpServer()).post(`/api/v1/plans/${planId}/runs`)
      .send(input).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/plans/${planId}/runs`)
      .set('Idempotency-Key', 'invalid').send(input).expect(400);
  });

  it('hides other users’ plans and runs on create, read, cancellation, and policy access', async () => {
    const projects = new ProjectsService(database as unknown as DatabaseService);
    const otherProject = await projects.createProject(outsider, { name: 'Other user project' });
    const otherTarget = await database.query<{ id: string }>(
      `INSERT INTO targets (project_id, name, base_url, approved_domains, authorization_confirmed_by)
       SELECT id, 'Other target', 'https://staging.example.test/', ARRAY['staging.example.test'], owner_user_id
       FROM projects WHERE id = $1 RETURNING id`, [otherProject.id],
    );
    const otherInput = { ...input, targetId: otherTarget.rows[0].id };
    const otherPlan = await plans.createPlan(outsider, otherProject.id, { name: 'Other plan', requirementsText: 'GET /health',
      script: { targetId: otherInput.targetId, workload: input.workload,
        scenarios: [{ name: 'Health', method: 'GET', path: '/health', expectedStatus: 200 }] } });
    await plans.reviewScript(outsider, otherPlan.id, 1, { reviewed: true, sha256: otherPlan.versions[0].script!.sha256 });
    const run = await runs.create(outsider, otherPlan.id, randomUUID(), otherInput);
    await request(app.getHttpServer()).post(`/api/v1/plans/${otherPlan.id}/runs`)
      .set('Idempotency-Key', randomUUID()).send(otherInput).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/runs/${run.runId}`).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/runs/${run.runId}/cancel`).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/plans/${otherPlan.id}/run-policy`).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/plans/${otherPlan.id}`)
      .set('Authorization', 'Bearer outsider').set('x-user-id', 'outsider').expect(404);
  });

  it('creates projects and reads plans with the same persistent local user and no auth header', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/projects').send({ name: 'Local smoke project' }).expect(201);
    const listed = await request(app.getHttpServer()).get('/api/v1/projects').expect(200);
    expect(listed.body.items.map((project: { id: string }) => project.id)).toContain(created.body.id);
    const plan = await request(app.getHttpServer()).post(`/api/v1/projects/${created.body.id}/plans`)
      .send({ name: 'Local plan', requirementsText: 'Prepare a local performance test.' }).expect(201);
    await request(app.getHttpServer()).get(`/api/v1/plans/${plan.body.id}`).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/plans/${planId}`).expect(200);
    const owner = await database.query('SELECT owner_user_id FROM projects WHERE id = $1', [created.body.id]);
    expect(owner.rows[0].owner_user_id).toBe(userId);
    expect((await database.query('SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2',
      [user.issuer, user.subject])).rowCount).toBe(1);
  });

  it('downloads the reviewed script without an authorization header', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/plans/${planId}/versions/1/script`).expect(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.text).toContain("import http from 'k6/http'");
  });

  it('still rejects the fixed local user when its account is disabled', async () => {
    await database.query('UPDATE users SET disabled_at = NOW() WHERE id = $1', [userId]);
    await request(app.getHttpServer()).get('/api/v1/projects').expect(403);
  });

  it('requires review bound to the actual checksum, including pre-Phase-4 reviews', async () => {
    await database.query('UPDATE plan_versions SET script_reviewed_sha256 = NULL');
    await expect(runs.create(user, planId, randomUUID(), input)).rejects.toMatchObject({ status: 409,
      response: { code: 'script_review_required' } });
    expect((await plans.getPlan(user, planId)).versions[0].script?.reviewStatus).toBe('pending');
    expect((await database.query('SELECT * FROM run_outbox')).rowCount).toBe(0);
  });

  it('rejects workload and target changes after review', async () => {
    await expect(runs.create(user, planId, randomUUID(), { ...input, workload: { virtualUsers: 2, durationSeconds: 1 } }))
      .rejects.toMatchObject({ status: 409 });
    await database.query("UPDATE targets SET base_url = 'https://changed.example.test/'");
    await expect(approvedRun()).rejects.toMatchObject({ status: 409 });
  });

  it('bounds global admitted runs and leaves no outbox row for the sixth request', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => approvedRun()));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
    expect((await database.query('SELECT * FROM run_outbox')).rowCount).toBe(5);
  });

  it('does not create a run when mandatory request limits are missing', async () => {
    const unconfigured = new RunsService(database as unknown as DatabaseService,
      new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60', MAX_REQUESTS_PER_SECOND: '' }));
    await expect(unconfigured.create(user, planId, randomUUID(), input)).rejects.toMatchObject({ status: 503 });
    expect((await database.query('SELECT * FROM test_runs')).rowCount).toBe(0);
  });

  it('cancels a queued run immediately and never dispatches or executes it', async () => {
    const run = await approvedRun(); const publish = jest.fn();
    const cancelled = await runs.cancel(user, run.runId); expect(cancelled.status).toBe('cancelled');
    expect((await runs.cancel(user, run.runId)).status).toBe('cancelled');
    expect(await new OutboxDispatcher(database, { publish }).dispatchOne()).toBe(false);
    expect(await store.claim(run.runId, 'fixture-host', readRunLimits(config))).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('recovers publication failure and re-enqueues still-queued runs after Redis data loss', async () => {
    const run = await approvedRun();
    const publish = jest.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(database, { publish });
    await expect(dispatcher.dispatchOne()).rejects.toThrow('queue unavailable');
    expect((await database.query('SELECT last_dispatched_at FROM run_outbox')).rows[0].last_dispatched_at).toBeNull();
    expect((await runs.get(user, run.runId)).status).toBe('queued');
    expect(await dispatcher.dispatchOne()).toBe(true);
    await database.query("UPDATE run_outbox SET last_dispatched_at = NOW() - INTERVAL '30 seconds'");
    expect(await dispatcher.dispatchOne()).toBe(true);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('runs only once for duplicate delivery and applies the bounded runtime options', async () => {
    const run = await approvedRun(); const engine = runtime();
    const pin = jest.fn().mockResolvedValue('93.184.216.34');
    const processor = new RunProcessor(store, engine, config, 'fixture-host', pin);
    await processor.process(run.runId); await processor.process(run.runId);
    expect(engine.execute).toHaveBeenCalledTimes(1);
    const [saved, ip, limits] = engine.execute.mock.calls[0];
    const wrapper = runtimeWrapper(saved, ip, limits);
    expect(wrapper).toContain('"iterations": 10'); expect(wrapper).toContain('"maxDuration": "1s"');
    expect(wrapper).toContain('"rps": 2'); expect(wrapper).toContain('93.184.216.34');
    expect((await runs.get(user, run.runId)).status).toBe('completed');
    expect((await runs.cancel(user, run.runId)).status).toBe('completed');
  });

  it('rejects changed DNS/policy before starting the runtime', async () => {
    const run = await approvedRun(); const engine = runtime();
    const processor = new RunProcessor(store, engine, config, 'fixture-host', jest.fn().mockRejectedValue(new Error('DNS changed')));
    await processor.process(run.runId);
    expect(engine.execute).not.toHaveBeenCalled();
    expect((await runs.get(user, run.runId)).status).toBe('failed');
  });

  it('revalidates membership and authorization before execution', async () => {
    const run = await approvedRun(); const engine = runtime();
    await database.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    await new RunProcessor(store, engine, config, 'fixture-host').process(run.runId);
    expect(engine.execute).not.toHaveBeenCalled();
    expect((await database.query('SELECT status, failure_code FROM test_runs')).rows[0])
      .toMatchObject({ status: 'failed', failure_code: 'authorization_revoked' });
  });

  it('moves running → cancelling → cancelled and aborts the runtime', async () => {
    const run = await approvedRun(); const engine = runtime();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    engine.execute.mockImplementation(async (_row, _ip, _limits, signal) => {
      started(); return new Promise<{ exitCode: number }>((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: 1 }), { once: true }));
    });
    const pending = new RunProcessor(store, engine, config, 'fixture-host', jest.fn().mockResolvedValue('93.184.216.34')).process(run.runId);
    await didStart;
    expect((await runs.cancel(user, run.runId)).status).toBe('cancelling');
    await pending;
    expect((await runs.get(user, run.runId)).status).toBe('cancelled');
  });

  it('recovers a crashed worker only after container stop and never reruns its test', async () => {
    const run = await approvedRun(); const engine = runtime();
    const claimed = await store.claim(run.runId, 'fixture-host', readRunLimits(config));
    await database.query("UPDATE test_runs SET heartbeat_at = NOW() - INTERVAL '60 seconds'");
    const processor = new RunProcessor(store, engine, config, 'fixture-host');
    expect(await processor.recoverOne()).toBe(true);
    expect(engine.stop).toHaveBeenCalledWith(run.runId);
    expect((await runs.get(user, run.runId)).status).toBe('failed');
    expect((await runs.get(user, run.runId)).failureCode).toBe('worker_lost');
    await store.finish(claimed!, null); // Stale execution token cannot overwrite recovery.
    await processor.process(run.runId);
    expect(engine.execute).not.toHaveBeenCalled();
    expect((await runs.get(user, run.runId)).status).toBe('failed');
  });

  it('keeps capacity reserved when a lost container cannot be confirmed stopped', async () => {
    const run = await approvedRun(); const engine = runtime(); engine.stop.mockResolvedValue(false);
    await store.claim(run.runId, 'fixture-host', readRunLimits(config));
    await database.query("UPDATE test_runs SET heartbeat_at = NOW() - INTERVAL '60 seconds'");
    await new RunProcessor(store, engine, config, 'fixture-host').recoverOne();
    expect((await runs.get(user, run.runId)).status).toBe('cancelling');
    expect((await runs.get(user, run.runId)).completedAt).toBeNull();
  });

  it('preserves a user cancellation when its worker is recovered', async () => {
    const run = await approvedRun(); const engine = runtime();
    await store.claim(run.runId, 'fixture-host', readRunLimits(config));
    await runs.cancel(user, run.runId);
    await database.query("UPDATE test_runs SET heartbeat_at = NOW() - INTERVAL '60 seconds'");
    await new RunProcessor(store, engine, config, 'fixture-host').recoverOne();
    expect((await runs.get(user, run.runId)).status).toBe('cancelled');
  });

  it('aborts a running test when target authorization is revoked', async () => {
    const run = await approvedRun(); const engine = runtime();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    engine.execute.mockImplementation(async (_row, _ip, _limits, signal) => {
      started(); return new Promise<{ exitCode: number }>((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: 1 }), { once: true }));
    });
    const pending = new RunProcessor(store, engine, config, 'fixture-host', jest.fn().mockResolvedValue('93.184.216.34')).process(run.runId);
    await didStart;
    await database.query('UPDATE targets SET disabled_at = NOW()');
    await pending;
    expect((await runs.get(user, run.runId)).status).toBe('failed');
    expect((await runs.get(user, run.runId)).failureCode).toBe('authorization_or_execution_revoked');
  });

  it('retains a run reservation when runtime cleanup is unconfirmed', async () => {
    const run = await approvedRun(); const engine = runtime();
    engine.execute.mockRejectedValue(new RuntimeNotStoppedError('not stopped'));
    await new RunProcessor(store, engine, config, 'fixture-host', jest.fn().mockResolvedValue('93.184.216.34')).process(run.runId);
    expect((await runs.get(user, run.runId)).status).toBe('running');
    expect((await runs.get(user, run.runId)).completedAt).toBeNull();
  });

  it('rolls back an outbox update after publication so a lost acknowledgement is retried', async () => {
    const run = await approvedRun(); const publish = jest.fn().mockResolvedValue(undefined);
    const connect = database.connect.bind(database);
    const spy = jest.spyOn(database, 'connect').mockImplementationOnce(async () => {
      const client = await connect();
      return { release: client.release, query: async (text, values) => {
        if (text.startsWith('UPDATE run_outbox')) throw new Error('simulated commit-path failure');
        return client.query(text, values);
      } };
    });
    const dispatcher = new OutboxDispatcher(database, { publish });
    await expect(dispatcher.dispatchOne()).rejects.toThrow('simulated commit-path failure');
    spy.mockRestore();
    expect((await database.query('SELECT last_dispatched_at FROM run_outbox WHERE run_id = $1', [run.runId])).rows[0].last_dispatched_at).toBeNull();
    await dispatcher.dispatchOne(); expect(publish).toHaveBeenCalledTimes(2);
  });
});
