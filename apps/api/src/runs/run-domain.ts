import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryResult, QueryResultRow } from 'pg';
import { ScriptDefinition, renderScript } from '../plans/planning-content';
import { evaluateWorkload, WorkloadRequest } from '../policies/workload-policy';
import { ResultSummary, SlaThresholds } from '../results/summary';

export const RUN_ADMISSION_LOCK = 174002004;
export const RUN_QUEUE = 'performance-runs-v1';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled';
export const TERMINAL_RUN_STATES: RunStatus[] = ['completed', 'failed', 'cancelled'];

export interface RunLimits {
  maxVirtualUsers: number;
  maxDurationSeconds: number;
  maxConcurrentRuns: number;
  maxRequestsPerSecond: number;
  maxRequestsPerRun: number;
}

export interface RunRow extends QueryResultRow {
  id: string;
  project_id: string;
  plan_version_id: string;
  target_id: string;
  requested_by: string;
  status: RunStatus;
  request_sha256: string;
  script_sha256: string;
  script_definition_json: ScriptDefinition;
  limits_json: RunLimits;
  authorization_confirmed_at: Date;
  approved_at: Date;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  failure_code: string | null;
  created_at: Date;
  worker_host_id: string | null;
  execution_token: string | null;
  result_status?: string;
  result_failure_code?: string | null;
  summary_json?: ResultSummary | null;
  sla_thresholds_json?: SlaThresholds;
}

export interface SqlClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  release(): void;
}
export interface SqlDatabase {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  connect(): Promise<SqlClient>;
}

export function positiveSetting(config: ConfigService, name: string, fallback?: number): number {
  const value = Number(config.get<string>(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ServiceUnavailableException({ code: 'run_policy_not_configured',
      message: `Configure ${name} as a positive integer before starting runs` });
  }
  return value;
}

export function readRunLimits(config: ConfigService): RunLimits {
  const limits = {
    maxVirtualUsers: positiveSetting(config, 'MAX_VIRTUAL_USERS'),
    maxDurationSeconds: positiveSetting(config, 'MAX_DURATION_SECONDS'),
    maxConcurrentRuns: positiveSetting(config, 'MAX_CONCURRENT_RUNS', 5),
    maxRequestsPerSecond: positiveSetting(config, 'MAX_REQUESTS_PER_SECOND'),
    maxRequestsPerRun: positiveSetting(config, 'MAX_REQUESTS_PER_RUN'),
  };
  if (limits.maxConcurrentRuns > 5) {
    throw new ServiceUnavailableException({ code: 'run_policy_not_configured',
      message: 'MAX_CONCURRENT_RUNS cannot exceed the architecture limit of 5' });
  }
  return limits;
}

export function validateRunWorkload(workload: WorkloadRequest, definition: ScriptDefinition, limits: RunLimits): void {
  renderScript(definition);
  const policy = evaluateWorkload(workload, limits, 0);
  if (!policy.allowed) throw new BadRequestException({ code: 'workload_policy_violation',
    message: 'Run workload exceeds configured limits', details: policy.violations });
  if (Math.floor(limits.maxRequestsPerRun / definition.scenarios.length) < workload.virtualUsers) {
    throw new BadRequestException({ code: 'workload_policy_violation',
      message: 'The total request ceiling must allow at least one complete iteration per virtual user' });
  }
}

export function runResponse(row: RunRow) {
  return {
    runId: row.id, projectId: row.project_id, planVersionId: row.plan_version_id,
    targetId: row.target_id, status: row.status, createdAt: row.created_at,
    authorizationConfirmedAt: row.authorization_confirmed_at, approvedAt: row.approved_at,
    queuedAt: row.queued_at, startedAt: row.started_at, completedAt: row.completed_at,
    failureCode: row.failure_code, workload: row.script_definition_json.workload,
    limits: row.limits_json, scriptSha256: row.script_sha256,
    statusUrl: `/api/v1/runs/${row.id}`,
    resultStatus: row.result_status ?? 'unavailable', resultFailureCode: row.result_failure_code ?? null,
    summary: row.summary_json ?? null,
  };
}
