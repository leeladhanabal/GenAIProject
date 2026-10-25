import { ConfigService } from '@nestjs/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { renderScript } from '../../api/src/plans/planning-content';
import { readRunLimits, RunRow } from '../../api/src/runs/run-domain';
import { DockerCommands, DockerK6Runtime, RuntimeNotStoppedError } from './docker-k6-runtime';

const config = new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60',
  MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10', MAX_CONCURRENT_RUNS: '5' });
const definition = { targetId: '3a52f4a2-5bf1-4c69-91a4-f3c9c3442f00', baseUrl: 'https://staging.example.test/',
  workload: { virtualUsers: 1, durationSeconds: 10 },
  scenarios: [{ name: 'Health', method: 'GET', path: '/health', expectedStatus: 200 }] };
const run = { id: '8dc50d11-b8ec-49f4-8532-5e74627ae440', script_definition_json: definition,
  script_sha256: renderScript(definition).sha256 } as RunRow;
const imageId = `sha256:${'a'.repeat(64)}`;

describe('Docker k6 runtime fencing and lifecycle (Docker commands mocked)', () => {
  let docker: jest.Mocked<DockerCommands>;
  let runtime: DockerK6Runtime;
  let staging: string;
  beforeEach(async () => {
    staging = await mkdtemp(join(tmpdir(), 'phase5-runtime-test-'));
    docker = { run: jest.fn().mockImplementation(async (args: string[]) => ({
      stdout: args[0] === 'image' ? `${imageId} phase5-k6-v1` : '', stderr: '',
    })), attach: jest.fn().mockResolvedValue(0) };
    runtime = new DockerK6Runtime(new ConfigService({ MAX_VIRTUAL_USERS: '10', MAX_DURATION_SECONDS: '60', MAX_REQUESTS_PER_SECOND: '2', MAX_REQUESTS_PER_RUN: '10', MAX_CONCURRENT_RUNS: '5', RESULT_STAGING_DIR: staging }), docker);
  });

  afterEach(async () => {
    await rm(staging, { recursive: true, force: true });
    // These commands were mocked: no container holds any of the test mounts.
    for (const [args] of docker.run.mock.calls) {
      if (args[0] === 'create') {
        const directory = args[args.indexOf('--mount') + 1].split(',')[1].slice(4);
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('mounts the exact reviewed bytes and checks ownership after create and before start', async () => {
    let directory = '';
    const order: string[] = [];
    docker.run.mockImplementation(async (args) => {
      order.push(args[0]);
      if (args[0] === 'create') {
        directory = args[args.indexOf('--mount') + 1].split(',')[1].slice(4);
        expect(await readFile(`${directory}/reviewed.js`, 'utf8')).toBe(renderScript(definition).content);
        expect(args.at(-1)).toBe(imageId);
      }
      return { stdout: args[0] === 'image' ? `${imageId} phase5-k6-v1` : '', stderr: '' };
    });
    docker.attach.mockImplementation(async () => { order.push('start'); return 0; });
    const canStart = jest.fn().mockImplementation(async () => { order.push('token-check'); return true; });
    await expect(runtime.execute(run, '93.184.216.34', readRunLimits(config), new AbortController().signal, canStart)).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
    expect(order).toEqual(['image', 'create', 'token-check', 'start', 'rm']);
    await expect(access(directory)).rejects.toThrow();
  });

  it('cannot start a container created by a stale worker after recovery has fenced it', async () => {
    const canStart = jest.fn().mockResolvedValue(false);
    await expect(runtime.execute(run, '93.184.216.34', readRunLimits(config), new AbortController().signal, canStart))
      .rejects.toThrow('execution_revoked');
    expect(docker.run.mock.calls.some(([args]) => args[0] === 'create')).toBe(true);
    expect(canStart).toHaveBeenCalledTimes(1);
    expect(docker.attach).not.toHaveBeenCalled();
    expect(docker.run.mock.calls.at(-1)?.[0][0]).toBe('rm');
  });

  it('fails closed when the final ownership check cannot reach PostgreSQL', async () => {
    const canStart = jest.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(runtime.execute(run, '93.184.216.34', readRunLimits(config), new AbortController().signal, canStart))
      .rejects.toThrow('database unavailable');
    expect(docker.attach).not.toHaveBeenCalled();
  });

  it('rejects an image missing the hardened execution profile', async () => {
    docker.run.mockResolvedValue({ stdout: `${imageId} <no value>`, stderr: '' });
    await expect(runtime.ready()).rejects.toThrow('hardened Phase 5');
    expect(docker.attach).not.toHaveBeenCalled();
  });

  it('rejects a modified script snapshot before any container is created', async () => {
    await expect(runtime.execute({ ...run, script_sha256: 'b'.repeat(64) }, '93.184.216.34', readRunLimits(config),
      new AbortController().signal, async () => true)).rejects.toThrow('script_checksum_mismatch');
    expect(docker.run.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
    expect(docker.attach).not.toHaveBeenCalled();
  });

  it('does not claim successful cleanup when Docker cannot confirm removal', async () => {
    docker.run.mockImplementation(async (args) => {
      if (args[0] === 'rm') throw new Error('daemon unavailable');
      return { stdout: args[0] === 'image' ? `${imageId} phase5-k6-v1` : '', stderr: '' };
    });
    await expect(runtime.execute(run, '93.184.216.34', readRunLimits(config), new AbortController().signal, async () => true))
      .rejects.toBeInstanceOf(RuntimeNotStoppedError);
  });
});
