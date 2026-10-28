import { ConfigService } from '@nestjs/config';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { renderScript } from '../../api/src/plans/planning-content';
import { positiveSetting, RunLimits, RunRow, validateRunWorkload } from '../../api/src/runs/run-domain';
import { stagingRoot } from '../../api/src/results/result-pipeline';

const exec = promisify(execFile);

export class RuntimeNotStoppedError extends Error {}
export interface K6ExecutionResult { exitCode: number; resultDirectory?: string }
export interface K6Runtime {
  execute(run: RunRow, pinnedIp: string, limits: RunLimits, signal: AbortSignal, canStart: () => Promise<boolean>): Promise<K6ExecutionResult>;
  stop(runId: string): Promise<boolean>;
}

export interface DockerCommands {
  run(args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  attach(name: string, signal: AbortSignal, timeoutMs: number): Promise<number>;
}

class DockerCli implements DockerCommands {
  run(args: string[], timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
    return exec('docker', args, { timeout: timeoutMs, maxBuffer: 8192, encoding: 'utf8' });
  }

  attach(name: string, signal: AbortSignal, timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', name], { stdio: 'ignore', shell: false });
      const terminate = () => { child.kill('SIGTERM'); };
      const timeout = setTimeout(terminate, timeoutMs);
      signal.addEventListener('abort', terminate, { once: true });
      if (signal.aborted) terminate();
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', terminate); };
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('close', (code) => { cleanup(); resolve(code ?? 1); });
    });
  }
}

export function runtimeWrapper(run: RunRow, pinnedIp: string, limits: RunLimits): string {
  validateRunWorkload(run.script_definition_json.workload, run.script_definition_json, limits);
  if (isIP(pinnedIp) !== 4 || ipaddr.process(pinnedIp).range() !== 'unicast') throw new Error('target_ipv4_required');
  const workload = run.script_definition_json.workload;
  const options = {
    scenarios: { bounded: { executor: 'shared-iterations', vus: workload.virtualUsers,
      iterations: Math.floor(limits.maxRequestsPerRun / run.script_definition_json.scenarios.length),
      maxDuration: `${workload.durationSeconds}s`, gracefulStop: '0s' } },
    rps: limits.maxRequestsPerSecond,
    hosts: { [new URL(run.script_definition_json.baseUrl).hostname]: pinnedIp },
    dns: { ttl: 'inf', policy: 'onlyIPv4' },
    maxRedirects: 0, discardResponseBodies: true, summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
  };
  // The reviewed module is byte-for-byte unchanged. Only this trusted root
  // module supplies execution settings, placing hard ceilings over its body.
  return `import reviewedTest from './reviewed.js';\nexport default reviewedTest;\nexport const options = ${JSON.stringify(options, null, 2)};\nexport function handleSummary(data) { return { '/output/summary.json': JSON.stringify(data) }; }\n`;
}

export function containerName(runId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('invalid_run_id');
  return `performance-run-${runId}`;
}

export function dockerArguments(run: RunRow, directory: string, pinnedIp: string, config: ConfigService, resolvedImage?: string): string[] {
  const memory = positiveSetting(config, 'WORKER_MEMORY_MB', 512);
  const image = resolvedImage ?? config.get<string>('K6_WORKER_IMAGE') ?? 'performance-k6:1.8.2-phase5';
  // Never use a shell. Environment and image settings are operator-only.
  return ['create', '--name', containerName(run.id), '--restart=no', '--read-only',
    '--cpus', String(positiveSetting(config, 'WORKER_CPUS', 1)),
    '--memory', `${memory}m`, '--memory-swap', `${memory}m`,
    '--pids-limit', String(positiveSetting(config, 'WORKER_PIDS_LIMIT', 128)),
    '--cap-drop=ALL', '--cap-add=NET_ADMIN', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=SETPCAP',
    '--security-opt=no-new-privileges:true', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
    '--network=bridge', '--stop-timeout=2', '--log-driver=none',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--mount', `type=bind,src=${directory},dst=/work,readonly`,
    '--mount', `type=bind,src=${join(stagingRoot(config), run.id)},dst=/output`,
    '--ulimit', `fsize=${positiveSetting(config, 'MAX_ARTIFACT_BYTES', 33554432)}:${positiveSetting(config, 'MAX_ARTIFACT_BYTES', 33554432)}`,
    '--env', `RUN_TARGET_IP=${pinnedIp}`,
    '--env', `RUN_WALL_SECONDS=${run.script_definition_json.workload.durationSeconds + 10}`,
    '--env', 'HTTP_PROXY=', '--env', 'HTTPS_PROXY=', '--env', 'ALL_PROXY=', '--env', 'NO_PROXY=*',
    '--env', 'http_proxy=', '--env', 'https_proxy=', '--env', 'all_proxy=', '--env', 'no_proxy=*',
    image];
}

export class DockerK6Runtime implements K6Runtime {
  private imageId: string | null = null;
  constructor(private readonly config: ConfigService, private readonly docker: DockerCommands = new DockerCli()) {}

  async ready(): Promise<void> {
    for (const [name, fallback] of [['WORKER_CPUS', 1], ['WORKER_MEMORY_MB', 512], ['WORKER_PIDS_LIMIT', 128]] as const) {
      positiveSetting(this.config, name, fallback);
    }
    const image = this.config.get<string>('K6_WORKER_IMAGE') ?? 'performance-k6:1.8.2-phase5';
    const result = await this.docker.run(['image', 'inspect', '--format',
      '{{.Id}} {{index .Config.Labels "org.performance-agent.profile"}}', image]);
    const [id, profile] = result.stdout.trim().split(/\s+/);
    if (!/^sha256:[a-f0-9]{64}$/.test(id) || profile !== 'phase5-k6-v1') throw new Error('Build the hardened Phase 5 k6 image before starting the worker');
    this.imageId = id;
  }

  async execute(run: RunRow, pinnedIp: string, limits: RunLimits, signal: AbortSignal, canStart: () => Promise<boolean>): Promise<K6ExecutionResult> {
    if (!this.imageId) await this.ready();
    const reviewed = renderScript(run.script_definition_json);
    if (reviewed.sha256 !== run.script_sha256) throw new Error('script_checksum_mismatch');
    const wrapper = runtimeWrapper(run, pinnedIp, limits);
    const directory = await mkdtemp(join(tmpdir(), 'performance-k6-'));
    const resultDirectory = join(stagingRoot(this.config), run.id);
    await mkdir(stagingRoot(this.config), { recursive: true, mode: 0o700 });
    await mkdir(resultDirectory, { mode: 0o777 });
    await chmod(resultDirectory, 0o777);
    let exitCode = 1;
    let executionError: unknown;
    try {
      await chmod(directory, 0o755);
      await writeFile(join(directory, 'reviewed.js'), reviewed.content, { mode: 0o444 });
      await writeFile(join(directory, 'runtime.js'), wrapper, { mode: 0o444 });
      if (signal.aborted) throw new Error('execution_aborted');
      await this.docker.run(dockerArguments(run, directory, pinnedIp, this.config, this.imageId!));
      // Check the DB execution token AFTER creating the unique container and
      // BEFORE starting it. Recovery can then remove that same container, or
      // deny a paused old process that creates it after recovery has finished.
      if (signal.aborted || !await canStart()) throw new Error('execution_revoked');
      exitCode = await this.docker.attach(containerName(run.id), signal,
        (run.script_definition_json.workload.durationSeconds + 15) * 1000);
    } catch (error) { executionError = error; }
    const stopped = await this.stop(run.id);
    // Keep the bind mount until the container is gone; never free capacity early.
    if (!stopped) throw new RuntimeNotStoppedError('container_stop_not_confirmed');
    await rm(directory, { recursive: true, force: true });
    if (executionError) throw executionError;
    return { exitCode, resultDirectory };
  }

  async stop(runId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.docker.run(['rm', '--force', containerName(runId)], 5000);
        return true;
      } catch (error) {
        const diagnostic = error as { stderr?: string };
        if (/No such (container|object)/i.test(diagnostic.stderr ?? '')) return true;
        if (attempt < 2) await delay(250 * 2 ** attempt);
      }
    }
    return false;
  }
}
