import {
  ABSOLUTE_MAX_CONCURRENT_RUNS,
  evaluateWorkload,
  WorkloadPolicyLimits,
} from './workload-policy';

const limits: WorkloadPolicyLimits = {
  maxVirtualUsers: 100,
  maxDurationSeconds: 600,
  maxConcurrentRuns: ABSOLUTE_MAX_CONCURRENT_RUNS,
};

describe('evaluateWorkload', () => {
  it('accepts a valid workload while capacity remains', () => {
    expect(
      evaluateWorkload({ virtualUsers: 20, durationSeconds: 300 }, limits, 0),
    ).toEqual({ allowed: true, violations: [] });
  });

  it('rejects workloads above configured virtual-user or duration ceilings', () => {
    expect(
      evaluateWorkload(
        { virtualUsers: 101, durationSeconds: 601 },
        limits,
        0,
      ),
    ).toEqual({
      allowed: false,
      violations: [
        'virtualUsers cannot exceed 100',
        'durationSeconds cannot exceed 600',
      ],
    });
  });

  it('rejects invalid workload values and a full run pool', () => {
    expect(
      evaluateWorkload({ virtualUsers: 0, durationSeconds: 1.5 }, limits, 5),
    ).toEqual({
      allowed: false,
      violations: [
        'virtualUsers must be a positive integer',
        'durationSeconds must be a positive integer',
        'concurrent run limit of 5 reached',
      ],
    });
  });

  it('rejects policy configuration that exceeds the architecture concurrency cap', () => {
    expect(() =>
      evaluateWorkload(
        { virtualUsers: 1, durationSeconds: 1 },
        { ...limits, maxConcurrentRuns: 6 },
        0,
      ),
    ).toThrow('maxConcurrentRuns cannot exceed 5');
  });
});
