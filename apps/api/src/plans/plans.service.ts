import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResult, QueryResultRow } from 'pg';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { CreatePlanVersionDto } from './dto/create-plan-version.dto';

interface PlanRow extends QueryResultRow {
  id: string;
  project_id: string;
  name: string;
  source_type: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  current_version?: number | null;
}

interface PlanVersionRow extends QueryResultRow {
  id: string;
  version: number;
  requirements_text: string;
  workload_json: Record<string, unknown>;
  created_at: Date;
}

@Injectable()
export class PlansService {
  constructor(private readonly database: DatabaseService) {}

  async createPlan(
    user: AuthenticatedUser,
    projectId: string,
    input: CreatePlanDto,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.upsertUser(
        (text, values) => client.query<{ id: string }>(text, values),
        user,
      );
      const access = await client.query(
        `SELECT 1 FROM project_members pm
         INNER JOIN projects p ON p.id = pm.project_id
         WHERE pm.project_id = $1 AND pm.user_id = $2
           AND p.deleted_at IS NULL`,
        [projectId, userId],
      );
      if (access.rowCount === 0) {
        throw new NotFoundException('Project not found');
      }

      const planResult = await client.query<PlanRow>(
        `INSERT INTO test_plans (project_id, created_by, name)
         VALUES ($1, $2, $3)
         RETURNING id, project_id, name, source_type, status,
                   created_at, updated_at`,
        [projectId, userId, input.name],
      );
      const plan = planResult.rows[0];
      const versionResult = await client.query<PlanVersionRow>(
        `INSERT INTO plan_versions
           (plan_id, version, requirements_text, created_by)
         VALUES ($1, 1, $2, $3)
         RETURNING id, version, requirements_text, workload_json, created_at`,
        [plan.id, input.requirementsText, userId],
      );
      const version = versionResult.rows[0];
      await client.query(
        `INSERT INTO audit_events
           (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'plan.created', 'plan', $3, $4::JSONB)`,
        [
          projectId,
          userId,
          plan.id,
          JSON.stringify({ name: plan.name, version: version.version }),
        ],
      );
      await client.query('COMMIT');

      return {
        ...this.toPlanResponse({
          ...plan,
          current_version: version.version,
        }),
        versions: [this.toVersionResponse(version)],
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listPlans(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ items: ReturnType<PlansService['toPlanResponse']>[] }> {
    const userId = await this.upsertUser(
      (text, values) => this.database.query<{ id: string }>(text, values),
      user,
    );
    const result = await this.database.query<PlanRow>(
      `SELECT p.id, p.project_id, p.name, p.source_type, p.status,
              p.created_at, p.updated_at,
              (SELECT MAX(pv.version) FROM plan_versions pv
               WHERE pv.plan_id = p.id) AS current_version
       FROM test_plans p
       INNER JOIN project_members pm ON pm.project_id = p.project_id
       INNER JOIN projects pr ON pr.id = p.project_id
       WHERE p.project_id = $1 AND pm.user_id = $2
         AND pr.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id`,
      [projectId, userId],
    );
    if (result.rows.length === 0) {
      await this.assertProjectAccess(projectId, userId);
    }

    return { items: result.rows.map((plan) => this.toPlanResponse(plan)) };
  }

  async getPlan(user: AuthenticatedUser, planId: string) {
    const userId = await this.upsertUser(
      (text, values) => this.database.query<{ id: string }>(text, values),
      user,
    );
    const plan = await this.findAccessiblePlan(planId, userId);
    const versions = await this.database.query<PlanVersionRow>(
      `SELECT id, version, requirements_text, workload_json, created_at
       FROM plan_versions
       WHERE plan_id = $1
       ORDER BY version`,
      [planId],
    );

    return {
      ...this.toPlanResponse(plan),
      versions: versions.rows.map((version) =>
        this.toVersionResponse(version),
      ),
    };
  }

  async createVersion(
    user: AuthenticatedUser,
    planId: string,
    input: CreatePlanVersionDto,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.upsertUser(
        (text, values) => client.query<{ id: string }>(text, values),
        user,
      );
      const planResult = await client.query<PlanRow>(
        `SELECT p.id, p.project_id, p.name, p.source_type, p.status,
                p.created_at, p.updated_at
         FROM test_plans p
         INNER JOIN project_members pm ON pm.project_id = p.project_id
         INNER JOIN projects pr ON pr.id = p.project_id
         WHERE p.id = $1 AND pm.user_id = $2 AND pr.deleted_at IS NULL
         FOR UPDATE OF p`,
        [planId, userId],
      );
      const plan = planResult.rows[0];
      if (!plan) {
        throw new NotFoundException('Plan not found');
      }

      const previous = await client.query<PlanVersionRow>(
        `SELECT id, version, requirements_text, workload_json, created_at
         FROM plan_versions
         WHERE plan_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [planId],
      );
      if (!previous.rows[0]) {
        throw new Error(`Plan ${planId} has no initial version`);
      }
      const versionResult = await client.query<PlanVersionRow>(
        `INSERT INTO plan_versions
           (plan_id, version, requirements_text, workload_json, created_by)
         VALUES ($1, $2, $3, $4::JSONB, $5)
         RETURNING id, version, requirements_text, workload_json, created_at`,
        [
          planId,
          previous.rows[0].version + 1,
          input.requirementsText,
          JSON.stringify(previous.rows[0].workload_json),
          userId,
        ],
      );
      const version = versionResult.rows[0];
      await client.query(
        'UPDATE test_plans SET updated_at = NOW() WHERE id = $1',
        [planId],
      );
      await client.query(
        `INSERT INTO audit_events
           (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'plan.version_created', 'plan', $3, $4::JSONB)`,
        [
          plan.project_id,
          userId,
          planId,
          JSON.stringify({ version: version.version }),
        ],
      );
      await client.query('COMMIT');

      return {
        ...this.toPlanResponse({
          ...plan,
          current_version: version.version,
        }),
        version: this.toVersionResponse(version),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findAccessiblePlan(
    planId: string,
    userId: string,
  ): Promise<PlanRow> {
    const result = await this.database.query<PlanRow>(
      `SELECT p.id, p.project_id, p.name, p.source_type, p.status,
              p.created_at, p.updated_at,
              (SELECT MAX(pv.version) FROM plan_versions pv
               WHERE pv.plan_id = p.id) AS current_version
       FROM test_plans p
       INNER JOIN project_members pm ON pm.project_id = p.project_id
       INNER JOIN projects pr ON pr.id = p.project_id
       WHERE p.id = $1 AND pm.user_id = $2 AND pr.deleted_at IS NULL`,
      [planId, userId],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('Plan not found');
    }
    return result.rows[0];
  }

  private async assertProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT 1 FROM project_members pm
       INNER JOIN projects p ON p.id = pm.project_id
       WHERE pm.project_id = $1 AND pm.user_id = $2
         AND p.deleted_at IS NULL`,
      [projectId, userId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException('Project not found');
    }
  }

  private async upsertUser(
    query: (
      text: string,
      values: unknown[],
    ) => Promise<QueryResult<{ id: string }>>,
    user: AuthenticatedUser,
  ): Promise<string> {
    const result = await query(
      `INSERT INTO users (oidc_issuer, oidc_subject, email, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (oidc_issuer, oidc_subject)
       DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
       WHERE users.disabled_at IS NULL
       RETURNING id`,
      [user.issuer, user.subject, user.email, user.displayName],
    );
    if (!result.rows[0]) {
      throw new ForbiddenException('This account is disabled');
    }
    return result.rows[0].id;
  }

  private toPlanResponse(plan: PlanRow) {
    return {
      id: plan.id,
      projectId: plan.project_id,
      name: plan.name,
      sourceType: plan.source_type,
      status: plan.status,
      currentVersion: plan.current_version ?? null,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
    };
  }

  private toVersionResponse(version: PlanVersionRow) {
    return {
      id: version.id,
      version: version.version,
      requirementsText: version.requirements_text,
      workload: version.workload_json,
      createdAt: version.created_at,
    };
  }
}
