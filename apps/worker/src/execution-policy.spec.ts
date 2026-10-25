import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { dockerArguments, runtimeWrapper } from './docker-k6-runtime';
import { pinExecutionTarget } from './target-preflight';
import { BullMqRunPublisher } from './main';
import { RunRow, readRunLimits } from '../../api/src/runs/run-domain';
import { renderScript } from '../../api/src/plans/planning-content';

const config = new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60', MAX_CONCURRENT_RUNS: '5',
  MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10', WORKER_CPUS: '1', WORKER_MEMORY_MB: '512', WORKER_PIDS_LIMIT: '128' });
const definition = { targetId: '3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00', baseUrl: 'https://staging.example.test/',
  workload: { virtualUsers: 2, durationSeconds: 10 }, scenarios: [
    { name: 'A', method: 'GET', path: '/a', expectedStatus: 200 },
    { name: 'B', method: 'GET', path: '/b', expectedStatus: 200 },
    { name: 'C', method: 'GET', path: '/c', expectedStatus: 200 },
  ] };
const run = { id: '8dc50d11-b8ec-49f4-8532-5e74627ae440', script_definition_json: definition,
  script_sha256: renderScript(definition).sha256 } as RunRow;

describe('Phase 4 execution policies', () => {
  it('re-resolves targets at execution and pins the same validated public IPv4 address', async () => {
    const resolve = jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await pinExecutionTarget(definition.baseUrl, ['staging.example.test'], resolve)).toBe('93.184.216.34');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '0.0.0.0', '::1']) (
    'rejects DNS changing to a non-public address: %s', async (address) => {
      const resolve = jest.fn().mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(pinExecutionTarget(definition.baseUrl, ['staging.example.test'], resolve))
        .rejects.toMatchObject({ response: { code: 'target_policy_violation' } });
    },
  );

  it('rejects mixed public/private records and IPv6-only records in the IPv4 Docker profile', async () => {
    await expect(pinExecutionTarget(definition.baseUrl, ['staging.example.test'], async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow();
    await expect(pinExecutionTarget(definition.baseUrl, ['staging.example.test'], async () => [
      { address: '2606:4700:4700::1111', family: 6 },
    ])).rejects.toThrow('target_ipv4_required');
  });

  it('bounds total generated requests across all VUs and scenarios without modifying the reviewed body', () => {
    const before = renderScript(definition);
    const wrapper = runtimeWrapper(run, '93.184.216.34', readRunLimits(config));
    expect(wrapper).toContain('"iterations": 3'); // floor(10 requests / 3 requests per iteration)
    expect(wrapper).toContain('"vus": 2');
    expect(wrapper).toContain('"maxDuration": "10s"');
    expect(wrapper).toContain('"gracefulStop": "0s"');
    expect(wrapper).toContain('"rps": 2');
    expect(wrapper).toContain('"maxRedirects": 0');
    expect(wrapper).toContain("import reviewedTest from './reviewed.js'");
    expect(renderScript(definition)).toEqual(before);
  });

  it('fails closed for non-public pins and impossible request budgets', () => {
    expect(() => runtimeWrapper(run, '127.0.0.1', readRunLimits(config))).toThrow();
    expect(() => runtimeWrapper(run, '93.184.216.34', { ...readRunLimits(config), maxRequestsPerRun: 2 })).toThrow();
    expect(() => readRunLimits(new ConfigService({ MAX_CONCURRENT_RUNS: '6', MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60',
      MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10' }))).toThrow();
  });

  it('applies container ceilings and never passes host credentials or a Docker socket into k6', () => {
    const args = dockerArguments(run, '/tmp/test-job', '93.184.216.34', config);
    expect(args).toEqual(expect.arrayContaining(['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--network=bridge', '--memory', '512m', '--memory-swap', '--pids-limit', '128', '--cpus', '1',
      '--env', 'RUN_TARGET_IP=93.184.216.34', 'RUN_WALL_SECONDS=20', 'HTTPS_PROXY=', 'NO_PROXY=*']));
    expect(args.join(' ')).not.toMatch(/docker\.sock|--privileged|--network=host|GROQ_API_KEY|DATABASE_URL|GOOGLE_CLIENT_ID/);
    const entrypoint = readFileSync('apps/worker/docker/entrypoint.sh', 'utf8');
    expect(entrypoint.indexOf('iptables -w -P OUTPUT DROP')).toBeLessThan(entrypoint.indexOf('exec setpriv'));
    expect(entrypoint).toContain('--bounding-set=-all');
    expect(entrypoint).toContain('--reuid=10001');
  });

  it('uses one queue job ID and no execution retries', async () => {
    const add = jest.fn(); const getJob = jest.fn().mockResolvedValue(undefined);
    const publisher = new BullMqRunPublisher({ add, getJob } as unknown as Queue);
    await publisher.publish(run.id);
    expect(add).toHaveBeenCalledWith('execute', { runId: run.id }, {
      jobId: run.id, attempts: 1, removeOnComplete: false, removeOnFail: false,
    });
  });

  it.each(['completed', 'failed', 'active'])('reconciles a prior queue record safely: %s', async (state) => {
    const remove = jest.fn(); const add = jest.fn();
    const publisher = new BullMqRunPublisher({ add,
      getJob: jest.fn().mockResolvedValue({ getState: jest.fn().mockResolvedValue(state), remove }),
    } as unknown as Queue);
    await publisher.publish(run.id);
    expect(remove).toHaveBeenCalledTimes(state === 'active' ? 0 : 1);
  });
});
