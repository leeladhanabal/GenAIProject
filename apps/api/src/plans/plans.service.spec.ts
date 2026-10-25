import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { PlansService } from './plans.service';
import { ConfigService } from '@nestjs/config';
import { GroqPlanningAdapter } from './groq-planning.adapter';
import { renderScript, ScriptDefinition } from './planning-content';

const user: AuthenticatedUser = {
  issuer: 'https://accounts.google.com',
  subject: 'subject-1',
  email: 'user@example.com',
  displayName: 'Test User',
};

const planRow = {
  id: 'plan-id', project_id: 'project-id', name: 'Checkout', source_type: 'manual',
  status: 'draft', current_version: 1, created_at: new Date(), updated_at: new Date(),
};
const scriptDefinition: ScriptDefinition = {
  targetId: '3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00', baseUrl: 'https://staging.example.test/',
  workload: { virtualUsers: 2, durationSeconds: 30 },
  scenarios: [{ name: 'Health', method: 'GET', path: '/health', expectedStatus: 200 }],
};
const versionRow = {
  id: 'version-id', version: 1, requirements_text: 'Exercise checkout flow',
  workload_json: {}, created_at: new Date(),
};

describe('PlansService', () => {
  let service: PlansService;
  let clientQuery: jest.Mock;
  let client: PoolClient;
  let database: DatabaseService;

  beforeEach(() => {
    clientQuery = jest.fn();
    client = {
      query: clientQuery,
      release: jest.fn(),
    } as unknown as PoolClient;
    database = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(),
    } as unknown as DatabaseService;
    service = new PlansService(database, new ConfigService({
      MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60',
    }), new GroqPlanningAdapter(new ConfigService({ GROQ_API_KEY: '' })));
  });

  it('creates a plan with its first immutable version in one transaction', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'plan-id',
            project_id: 'project-id',
            name: 'Checkout',
            source_type: 'manual',
            status: 'draft',
            created_at: new Date('2026-10-25T00:00:00Z'),
            updated_at: new Date('2026-10-25T00:00:00Z'),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'version-id',
            version: 1,
            requirements_text: 'Exercise checkout flow',
            workload_json: {},
            created_at: new Date('2026-10-25T00:00:00Z'),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });

    const result = await service.createPlan(user, 'project-id', {
      name: 'Checkout',
      requirementsText: 'Exercise checkout flow',
    });

    expect(result.currentVersion).toBe(1);
    expect(result.versions).toEqual([
      expect.objectContaining({
        id: 'version-id',
        version: 1,
        requirementsText: 'Exercise checkout flow',
        workload: {},
      }),
    ]);
    expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('hides inaccessible projects and rolls back plan creation', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });

    await expect(
      service.createPlan(user, 'other-project', {
        name: 'Checkout',
        requirementsText: 'Exercise checkout flow',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(clientQuery).toHaveBeenCalledTimes(4);
  });

  it('creates the next version and carries forward its workload snapshot', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'plan-id',
            project_id: 'project-id',
            name: 'Checkout',
            source_type: 'manual',
            status: 'draft',
            created_at: new Date('2026-10-25T00:00:00Z'),
            updated_at: new Date('2026-10-25T00:00:00Z'),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'old-version',
            version: 2,
            requirements_text: 'Previous requirements',
            workload_json: { virtualUsers: 10 },
            created_at: new Date('2026-10-25T00:00:00Z'),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'new-version',
            version: 3,
            requirements_text: 'Updated requirements',
            workload_json: { virtualUsers: 10 },
            created_at: new Date('2026-10-25T00:00:00Z'),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });

    const result = await service.createVersion(user, 'plan-id', {
      requirementsText: 'Updated requirements',
    });

    expect(result.currentVersion).toBe(3);
    expect(result.version.workload).toEqual({ virtualUsers: 10 });
    expect(clientQuery.mock.calls[4][1]).toEqual([
      'plan-id',
      3,
      'Updated requirements',
      JSON.stringify({ virtualUsers: 10 }),
      'user-id',
      null,
      null,
    ]);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('saves validated script metadata and scenarios transactionally with review pending', async () => {
    const newVersion = { ...versionRow, version: 2, script_definition_json: scriptDefinition,
      workload_json: scriptDefinition.workload };
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [planRow] })
      .mockResolvedValueOnce({ rows: [versionRow] })
      .mockResolvedValueOnce({ rows: [{ base_url: scriptDefinition.baseUrl }] })
      .mockResolvedValueOnce({ rows: [newVersion] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: new Date('2026-10-25T12:30:00Z') }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await service.createVersion(user, 'plan-id', {
      requirementsText: versionRow.requirements_text, expectedVersion: 1,
      script: { targetId: scriptDefinition.targetId, workload: scriptDefinition.workload,
        scenarios: scriptDefinition.scenarios },
    });
    expect(result.version.script?.reviewStatus).toBe('pending');
    expect(result.version.script?.content).toContain('https://staging.example.test/health');
    expect(result.updatedAt).toEqual(new Date('2026-10-25T12:30:00Z'));
    expect(clientQuery.mock.calls[4][1]).toEqual([scriptDefinition.targetId, 'project-id']);
    expect(clientQuery.mock.calls[6][0]).toContain('INSERT INTO scenarios');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('rejects stale edits before inserting a version', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [planRow] })
      .mockResolvedValueOnce({ rows: [{ ...versionRow, version: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service.createVersion(user, 'plan-id', {
      requirementsText: 'Stale requirements', expectedVersion: 1,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO plan_versions'))).toBe(false);
  });

  it('does not reveal versions of an inaccessible plan', async () => {
    jest.mocked(database.query).mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await expect(service.getPlan(user, 'hidden-plan')).rejects.toBeInstanceOf(NotFoundException);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('records review only for the exact immutable script checksum', async () => {
    const savedVersion = { ...versionRow, project_id: 'project-id', script_definition_json: scriptDefinition };
    const reviewedAt = new Date();
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [savedVersion] })
      .mockResolvedValueOnce({ rows: [{ ...savedVersion, script_reviewed_at: reviewedAt,
        script_reviewed_sha256: renderScript(scriptDefinition).sha256 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const sha256 = renderScript(scriptDefinition).sha256;
    const result = await service.reviewScript(user, 'plan-id', 1, { reviewed: true, sha256 });
    expect(result.script?.reviewStatus).toBe('reviewed');
    expect(result.script?.reviewedAt).toBe(reviewedAt);
    expect(clientQuery.mock.calls[2][0]).toContain('pm.user_id = $3');
    expect(clientQuery.mock.calls[4][0]).toContain('plan.script_reviewed');
  });

  it('rejects a mismatched checksum without recording a review', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [{ ...versionRow, script_definition_json: scriptDefinition }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service.reviewScript(user, 'plan-id', 1, { reviewed: true, sha256: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([null, new Date()])('enforces review before script downloads (%p)', async (reviewedAt) => {
    jest.mocked(database.query).mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never)
      .mockResolvedValueOnce({ rows: [planRow] } as never)
      .mockResolvedValueOnce({ rows: [{ ...versionRow, script_definition_json: scriptDefinition,
        script_reviewed_at: reviewedAt, script_reviewed_sha256: renderScript(scriptDefinition).sha256 }] } as never);
    const result = service.downloadScript(user, 'plan-id', 1);
    if (reviewedAt) await expect(result).resolves.toEqual(expect.objectContaining({ reviewStatus: 'reviewed' }));
    else await expect(result).rejects.toBeInstanceOf(ConflictException);
  });

  function mockGenerationRead() {
    jest.mocked(database.query).mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never)
      .mockResolvedValueOnce({ rows: [planRow] } as never)
      .mockResolvedValueOnce({ rows: [versionRow] } as never)
      .mockResolvedValueOnce({ rows: [{ base_url: scriptDefinition.baseUrl }] } as never);
  }

  it('reports missing Groq credentials instead of fabricating generation', async () => {
    mockGenerationRead();
    await expect(service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: scriptDefinition.workload }))
      .rejects.toMatchObject({ response: { code: 'ai_provider_not_configured' } });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('validates provider output before persisting it', async () => {
    const generate = jest.fn().mockResolvedValue({ scenarios: [
      { name: 'Injected', method: 'GET', path: 'https://evil.example', expectedStatus: 200 },
    ] });
    service = new PlansService(database, new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60' }), { generate });
    mockGenerationRead();
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [planRow] })
      .mockResolvedValueOnce({ rows: [versionRow] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: scriptDefinition.workload }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(generate).toHaveBeenCalledWith({ requirementsText: versionRow.requirements_text, specification: null });
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO plan_versions'))).toBe(false);
  });

  it('turns valid provider contract output into a pending immutable version', async () => {
    const generate = jest.fn().mockResolvedValue({ scenarios: scriptDefinition.scenarios });
    service = new PlansService(database, new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60' }), { generate });
    mockGenerationRead();
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [planRow] })
      .mockResolvedValueOnce({ rows: [versionRow] })
      .mockResolvedValueOnce({ rows: [{ base_url: scriptDefinition.baseUrl }] })
      .mockResolvedValueOnce({ rows: [{ ...versionRow, version: 2,
        script_definition_json: scriptDefinition, workload_json: scriptDefinition.workload }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: scriptDefinition.workload });
    expect(result.currentVersion).toBe(2);
    expect(result.version.script?.reviewStatus).toBe('pending');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[5][1][1]).toBe(2);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('rejects a target unavailable in this project before contacting AI', async () => {
    const generate = jest.fn();
    service = new PlansService(database, new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60' }), { generate });
    jest.mocked(database.query).mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never)
      .mockResolvedValueOnce({ rows: [planRow] } as never)
      .mockResolvedValueOnce({ rows: [versionRow] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await expect(service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: scriptDefinition.workload }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(database.query).toHaveBeenLastCalledWith(expect.stringContaining('project_id = $2'),
      [scriptDefinition.targetId, 'project-id']);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects excessive draft workloads before contacting AI', async () => {
    const generate = jest.fn();
    service = new PlansService(database, new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60' }), { generate });
    mockGenerationRead();
    await expect(service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: { virtualUsers: 11, durationSeconds: 30 } }))
      .rejects.toMatchObject({ response: { code: 'workload_policy_violation' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects scripts when workload ceilings are unconfigured', async () => {
    service = new PlansService(database, new ConfigService({ MAX_VIRTUAL_USERS: '', MAX_DURATION_SECONDS: '' }),
      new GroqPlanningAdapter(new ConfigService({ GROQ_API_KEY: '' })));
    mockGenerationRead();
    await expect(service.generate(user, 'plan-id', { version: 1,
      targetId: scriptDefinition.targetId, workload: scriptDefinition.workload }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
