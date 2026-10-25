import { NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { PlansService } from './plans.service';

const user: AuthenticatedUser = {
  issuer: 'https://accounts.google.com',
  subject: 'subject-1',
  email: 'user@example.com',
  displayName: 'Test User',
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
    service = new PlansService(database);
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
    ]);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
});
