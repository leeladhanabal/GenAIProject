export interface WorkloadRequest {
  virtualUsers: number;
  durationSeconds: number;
}

export interface WorkloadPolicyLimits {
  maxVirtualUsers: number;
  maxDurationSeconds: number;
  maxConcurrentRuns: number;
}

export interface WorkloadPolicyResult {
  allowed: boolean;
  violations: string[];
}

export const ABSOLUTE_MAX_CONCURRENT_RUNS = 5;

export function evaluateWorkload(
  request: WorkloadRequest,
  limits: WorkloadPolicyLimits,
  activeRuns: number,
): WorkloadPolicyResult {
  assertPositiveInteger('maxVirtualUsers', limits.maxVirtualUsers);
  assertPositiveInteger('maxDurationSeconds', limits.maxDurationSeconds);
  assertPositiveInteger('maxConcurrentRuns', limits.maxConcurrentRuns);

  if (limits.maxConcurrentRuns > ABSOLUTE_MAX_CONCURRENT_RUNS) {
    throw new RangeError(
      `maxConcurrentRuns cannot exceed ${ABSOLUTE_MAX_CONCURRENT_RUNS}`,
    );
  }

  const violations: string[] = [];

  if (!Number.isInteger(request.virtualUsers) || request.virtualUsers < 1) {
    violations.push('virtualUsers must be a positive integer');
  } else if (request.virtualUsers > limits.maxVirtualUsers) {
    violations.push(`virtualUsers cannot exceed ${limits.maxVirtualUsers}`);
  }

  if (!Number.isInteger(request.durationSeconds) || request.durationSeconds < 1) {
    violations.push('durationSeconds must be a positive integer');
  } else if (request.durationSeconds > limits.maxDurationSeconds) {
    violations.push(`durationSeconds cannot exceed ${limits.maxDurationSeconds}`);
  }

  if (!Number.isInteger(activeRuns) || activeRuns < 0) {
    throw new RangeError('activeRuns must be a non-negative integer');
  }

  if (activeRuns >= limits.maxConcurrentRuns) {
    violations.push(`concurrent run limit of ${limits.maxConcurrentRuns} reached`);
  }

  return { allowed: violations.length === 0, violations };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
