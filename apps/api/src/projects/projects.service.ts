import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResult } from 'pg';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { DatabaseService } from '../database/database.service';
import { normalizeAndValidateTarget } from './target-url-policy';
import { CreateProjectDto } from './dto/create-project.dto';
import { RegisterTargetDto } from './dto/register-target.dto';

interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

interface TargetRow {
  id: string;
  name: string;
  base_url: string;
  approved_domains: string[];
  created_at: Date;
  authorization_confirmed_at: Date;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async createProject(
    user: AuthenticatedUser,
    input: CreateProjectDto,
  ): Promise<{ id: string; name: string; createdAt: Date }> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const userId = await this.upsertUser(
        (text, values) => client.query<{ id: string }>(text, values),
        user,
      );
      const result = await client.query<ProjectRow>(
        `INSERT INTO projects (name, owner_user_id)
         VALUES ($1, $2)
         RETURNING id, name, created_at, updated_at`,
        [input.name, userId],
      );
      const project = result.rows[0];

      await client.query(
        'INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)',
        [project.id, userId],
      );
      await client.query(
        `INSERT INTO audit_events
           (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'project.created', 'project', $1, $3::JSONB)`,
        [project.id, userId, JSON.stringify({ name: project.name })],
      );
      await client.query('COMMIT');

      return {
        id: project.id,
        name: project.name,
        createdAt: project.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjects(user: AuthenticatedUser): Promise<{
    items: Array<{ id: string; name: string; createdAt: Date; updatedAt: Date }>;
  }> {
    const userId = await this.upsertUser(
      (text, values) => this.database.query<{ id: string }>(text, values),
      user,
    );
    const result = await this.database.query<ProjectRow>(
      `SELECT p.id, p.name, p.created_at, p.updated_at
       FROM projects p
       INNER JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id`,
      [userId],
    );

    return {
      items: result.rows.map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      })),
    };
  }

  async registerTarget(
    user: AuthenticatedUser,
    projectId: string,
    input: RegisterTargetDto,
  ): Promise<{
    id: string;
    name: string;
    status: 'active';
    baseUrl: string;
    approvedDomains: string[];
    createdAt: Date;
  }> {
    const userId = await this.upsertUser(
      (text, values) => this.database.query<{ id: string }>(text, values),
      user,
    );
    await this.assertProjectAccess(projectId, userId);

    const validatedTarget = await normalizeAndValidateTarget(
      input.baseUrl,
      input.approvedDomains,
    );
    const client = await this.database.connect();

    try {
      await client.query('BEGIN');
      const projectAccess = await client.query(
        `SELECT 1 FROM project_members pm
         INNER JOIN projects p ON p.id = pm.project_id
         WHERE pm.project_id = $1 AND pm.user_id = $2
           AND p.deleted_at IS NULL`,
        [projectId, userId],
      );
      if (projectAccess.rowCount === 0) {
        throw new NotFoundException('Project not found');
      }

      const result = await client.query<TargetRow>(
        `INSERT INTO targets
           (project_id, name, base_url, approved_domains,
            authorization_confirmed_by, authorization_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, name, base_url, approved_domains, created_at,
                   authorization_confirmed_at`,
        [
          projectId,
          input.name,
          validatedTarget.baseUrl,
          validatedTarget.approvedDomains,
          userId,
        ],
      );
      const target = result.rows[0];
      await client.query(
        `INSERT INTO audit_events
           (project_id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES ($1, $2, 'target.registered', 'target', $3, $4::JSONB)`,
        [
          projectId,
          userId,
          target.id,
          JSON.stringify({
            name: target.name,
            hostname: new URL(target.base_url).hostname,
            approvedDomains: target.approved_domains,
          }),
        ],
      );
      await client.query('COMMIT');

      return {
        id: target.id,
        name: target.name,
        status: 'active',
        baseUrl: target.base_url,
        approvedDomains: target.approved_domains,
        createdAt: target.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listTargets(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{
    items: Array<{
      id: string;
      name: string;
      status: 'active';
      baseUrl: string;
      approvedDomains: string[];
      authorizationConfirmedAt: Date;
      createdAt: Date;
    }>;
  }> {
    const userId = await this.upsertUser(
      (text, values) => this.database.query<{ id: string }>(text, values),
      user,
    );
    await this.assertProjectAccess(projectId, userId);
    const result = await this.database.query<TargetRow>(
      `SELECT id, name, base_url, approved_domains, created_at,
              authorization_confirmed_at
       FROM targets
       WHERE project_id = $1 AND disabled_at IS NULL
       ORDER BY created_at DESC, id`,
      [projectId],
    );

    return {
      items: result.rows.map((target) => ({
        id: target.id,
        name: target.name,
        status: 'active',
        baseUrl: target.base_url,
        approvedDomains: target.approved_domains,
        authorizationConfirmedAt: target.authorization_confirmed_at,
        createdAt: target.created_at,
      })),
    };
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
}
