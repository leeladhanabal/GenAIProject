import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryResult, QueryResultRow } from 'pg';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { CreatePlanVersionDto } from './dto/create-plan-version.dto';
import { GeneratePlanDto, ReviewScriptDto } from './dto/generate-plan.dto';
import { AI_PLANNING_ADAPTER, AiPlanningAdapter } from './ai-planning.adapter';
import { normalizeSpecification, parseScriptInput, renderScript, ScriptDefinition, Specification } from './planning-content';
import { evaluateWorkload } from '../policies/workload-policy';

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
  specification_json?: Specification | null;
  script_definition_json?: ScriptDefinition | null;
  script_reviewed_at?: Date | null;
  script_reviewed_sha256?: string | null;
}

@Injectable()
export class PlansService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    @Inject(AI_PLANNING_ADAPTER) private readonly ai: AiPlanningAdapter,
  ) {}

  async createPlan(
    user: AuthenticatedUser,
    projectId: string,
    input: CreatePlanDto,
  ) {
    const specification = input.specification ? normalizeSpecification(input.specification) : null;
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

      const script = input.script ? await this.prepareScript(
        (text, values) => client.query(text, values), projectId, input.script,
      ) : null;

      const planResult = await client.query<PlanRow>(
        `INSERT INTO test_plans (project_id, created_by, name, source_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, project_id, name, source_type, status,
                   created_at, updated_at`,
        [projectId, userId, input.name, specification ? 'openapi' : 'manual'],
      );
      const plan = planResult.rows[0];
      const versionResult = await client.query<PlanVersionRow>(
        `INSERT INTO plan_versions
           (plan_id, version, requirements_text, created_by, specification_json,
            script_definition_json, workload_json)
         VALUES ($1, 1, $2, $3, $4::JSONB, $5::JSONB, $6::JSONB)
         RETURNING *`,
        [plan.id, input.requirementsText, userId, specification ? JSON.stringify(specification) : null,
          script ? JSON.stringify(script) : null, JSON.stringify(script?.workload ?? {})],
      );
      const version = versionResult.rows[0];
      await this.saveScenarios((text, values) => client.query(text, values), version.id, script);
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
      `SELECT *
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
    const specification = input.specification ? normalizeSpecification(input.specification) : undefined;
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
        `SELECT *
         FROM plan_versions
         WHERE plan_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [planId],
      );
      if (!previous.rows[0]) {
        throw new Error(`Plan ${planId} has no initial version`);
      }
      if (input.expectedVersion !== undefined && previous.rows[0].version !== input.expectedVersion) {
        throw new ConflictException('The plan changed. Read the latest version before editing or generating.');
      }
      const script = input.script ? await this.prepareScript(
        (text, values) => client.query(text, values), plan.project_id, input.script,
      ) : null;
      const versionResult = await client.query<PlanVersionRow>(
        `INSERT INTO plan_versions
           (plan_id, version, requirements_text, workload_json, created_by,
            specification_json, script_definition_json)
         VALUES ($1, $2, $3, $4::JSONB, $5, $6::JSONB, $7::JSONB)
         RETURNING *`,
        [
          planId,
          previous.rows[0].version + 1,
          input.requirementsText,
          JSON.stringify(script?.workload ?? previous.rows[0].workload_json),
          userId,
          specification || previous.rows[0].specification_json
            ? JSON.stringify(specification ?? previous.rows[0].specification_json) : null,
          script ? JSON.stringify(script) : null,
        ],
      );
      const version = versionResult.rows[0];
      await this.saveScenarios((text, values) => client.query(text, values), version.id, script);
      const updated = await client.query<{ updated_at: Date }>(
        'UPDATE test_plans SET updated_at = NOW() WHERE id = $1 RETURNING updated_at',
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
          updated_at: updated.rows[0]?.updated_at ?? plan.updated_at,
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

  async generate(user: AuthenticatedUser, planId: string, input: GeneratePlanDto) {
    const plan = await this.getPlan(user, planId);
    if (input.version !== plan.currentVersion) throw new ConflictException('Generate from the current plan version');
    const version = plan.versions.find((item) => item.version === input.version);
    if (!version) throw new NotFoundException('Plan version not found');
    // Validate target and workload before making any provider call. A provider
    // implementation can only propose scenario data, never executable code.
    await this.prepareScript((text, values) => this.database.query(text, values), plan.projectId, {
      targetId: input.targetId, workload: input.workload,
      scenarios: [{ name: 'Validation', method: 'GET', path: '/', expectedStatus: 200 }],
    });
    const output = await this.ai.generate({ requirementsText: version.requirementsText,
      specification: version.specification });
    if (!output || !Array.isArray(output.scenarios)) {
      throw new BadRequestException({ code: 'ai_output_invalid', message: 'AI output must contain scenarios' });
    }
    return this.createVersion(user, planId, {
      requirementsText: version.requirementsText,
      expectedVersion: input.version,
      script: { targetId: input.targetId, workload: input.workload, scenarios: output.scenarios },
    });
  }

  async reviewScript(user: AuthenticatedUser, planId: string, versionNumber: number, input: ReviewScriptDto) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.upsertUser((text, values) => client.query(text, values), user);
      const result = await client.query<PlanVersionRow & { project_id: string }>(
        `SELECT pv.*, p.project_id FROM plan_versions pv
         JOIN test_plans p ON p.id = pv.plan_id
         JOIN project_members pm ON pm.project_id = p.project_id
         JOIN projects pr ON pr.id = p.project_id
         WHERE p.id = $1 AND pv.version = $2 AND pm.user_id = $3 AND pr.deleted_at IS NULL
         FOR UPDATE OF pv`, [planId, versionNumber, userId],
      );
      const version = result.rows[0];
      if (!version) throw new NotFoundException('Plan version not found');
      if (!version.script_definition_json) throw new ConflictException('This version has no script');
      if (input.reviewed !== true || renderScript(version.script_definition_json).sha256 !== input.sha256) {
        throw new ConflictException('Review must confirm the exact script checksum');
      }
      const updated = await client.query<PlanVersionRow>(
        `UPDATE plan_versions SET script_reviewed_by = $1, script_reviewed_at = NOW(), script_reviewed_sha256 = $3
         WHERE id = $2 RETURNING *`, [userId, version.id, input.sha256],
      );
      await client.query(
        `INSERT INTO audit_events
           (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'plan.script_reviewed', 'plan_version', $3, $4::JSONB)`,
        [version.project_id, userId, version.id, JSON.stringify({ sha256: input.sha256, version: versionNumber })],
      );
      await client.query('COMMIT');
      return this.toVersionResponse(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async downloadScript(user: AuthenticatedUser, planId: string, versionNumber: number) {
    const plan = await this.getPlan(user, planId);
    const version = plan.versions.find((item) => item.version === versionNumber);
    if (!version) throw new NotFoundException('Plan version not found');
    if (!version.script) throw new ConflictException('This version has no script');
    if (version.script.reviewStatus !== 'reviewed') throw new ConflictException('Review this script before downloading');
    return version.script;
  }

  private async prepareScript(
    query: (text: string, values: unknown[]) => Promise<QueryResult>,
    projectId: string, value: unknown,
  ): Promise<ScriptDefinition> {
    const input = parseScriptInput(value);
    const maxVirtualUsers = Number(this.config.get<string>('MAX_VIRTUAL_USERS'));
    const maxDurationSeconds = Number(this.config.get<string>('MAX_DURATION_SECONDS'));
    if (!Number.isSafeInteger(maxVirtualUsers) || maxVirtualUsers < 1 ||
        !Number.isSafeInteger(maxDurationSeconds) || maxDurationSeconds < 1) {
      throw new ServiceUnavailableException({ code: 'workload_policy_not_configured',
        message: 'Configure approved MAX_VIRTUAL_USERS and MAX_DURATION_SECONDS before creating scripts' });
    }
    const policy = evaluateWorkload(input.workload, { maxVirtualUsers, maxDurationSeconds, maxConcurrentRuns: 5 }, 0);
    if (!policy.allowed) throw new BadRequestException({ code: 'workload_policy_violation',
      message: 'Draft workload exceeds configured limits', details: policy.violations });
    const target = await query(
      `SELECT base_url FROM targets WHERE id = $1 AND project_id = $2
       AND disabled_at IS NULL AND authorization_confirmed_at IS NOT NULL`, [input.targetId, projectId],
    );
    if (!target.rows[0]) throw new NotFoundException('Target not found');
    const definition = { ...input, baseUrl: target.rows[0].base_url as string };
    renderScript(definition);
    return definition;
  }

  private async saveScenarios(
    query: (text: string, values: unknown[]) => Promise<QueryResult>,
    versionId: string, script: ScriptDefinition | null,
  ) {
    if (!script) return;
    for (const scenario of script.scenarios) {
      await query(`INSERT INTO scenarios (plan_version_id, name, k6_options_json)
        VALUES ($1, $2, $3::JSONB)`, [versionId, scenario.name, JSON.stringify(scenario)]);
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
    const rendered = version.script_definition_json ? renderScript(version.script_definition_json) : null;
    const reviewed = !!(rendered && version.script_reviewed_at && version.script_reviewed_sha256 === rendered.sha256);
    return {
      id: version.id,
      version: version.version,
      requirementsText: version.requirements_text,
      workload: version.workload_json,
      createdAt: version.created_at,
      specification: version.specification_json ?? null,
      script: version.script_definition_json && rendered ? {
        ...rendered,
        definition: version.script_definition_json,
        validationStatus: 'valid' as const,
        reviewStatus: reviewed ? 'reviewed' as const : 'pending' as const,
        reviewedAt: reviewed ? version.script_reviewed_at : null,
      } : null,
    };
  }
}
