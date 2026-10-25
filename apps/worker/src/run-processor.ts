import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderScript } from '../../api/src/plans/planning-content';
import { readRunLimits, RunLimits, validateRunWorkload } from '../../api/src/runs/run-domain';
import { K6Runtime, RuntimeNotStoppedError } from './docker-k6-runtime';
import { RunStore } from './run-store';
import { pinExecutionTarget } from './target-preflight';
import { stagingRoot } from '../../api/src/results/result-pipeline';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

function failureCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && 'code' in response && typeof response.code === 'string') return response.code;
  }
  if (error instanceof Error && ['target_ipv4_required', 'script_checksum_mismatch'].includes(error.message)) return error.message;
  return 'worker_execution_failed';
}

export class RunProcessor {
  constructor(private readonly store: RunStore, private readonly runtime: K6Runtime,
    private readonly config: ConfigService, private readonly hostId: string,
    private readonly pinTarget: typeof pinExecutionTarget = pinExecutionTarget) {}

  async process(runId: string, shutdown?: AbortSignal): Promise<void> {
    const currentLimits = readRunLimits(this.config);
    const run = await this.store.claim(runId, this.hostId, currentLimits);
    if (!run) return; // Duplicate queue delivery never starts a second container.
    const controller = new AbortController();
    const abort = () => controller.abort();
    shutdown?.addEventListener('abort', abort, { once: true });
    if (shutdown?.aborted) abort();
    let stopped = true;
    let code: string | null = null;
    let resultDirectory: string | undefined;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.store.heartbeat(run).then((running) => {
        if (!running) { code = 'authorization_or_execution_revoked'; abort(); }
      }).catch(() => { code = 'worker_heartbeat_failed'; abort(); })
        .finally(() => { heartbeatBusy = false; });
    }, 500);
    try {
      const context = await this.store.executionContext(run);
      if (!context) { code = 'authorization_revoked'; throw new Error('authorization_revoked'); }
      if (context.base_url !== run.script_definition_json.baseUrl ||
          context.script_reviewed_sha256 !== run.script_sha256 ||
          renderScript(run.script_definition_json).sha256 !== run.script_sha256) {
        throw new Error('script_checksum_mismatch');
      }
      // A later policy increase never raises the ceilings approved for a run.
      const limits: RunLimits = { ...currentLimits,
        maxRequestsPerSecond: Math.min(currentLimits.maxRequestsPerSecond, run.limits_json.maxRequestsPerSecond),
        maxRequestsPerRun: Math.min(currentLimits.maxRequestsPerRun, run.limits_json.maxRequestsPerRun) };
      validateRunWorkload(run.script_definition_json.workload, run.script_definition_json, limits);
      const ip = await this.pinTarget(context.base_url, context.approved_domains);
      if (!await this.store.heartbeat(run)) { code = 'authorization_or_execution_revoked'; controller.abort(); }
      if (!controller.signal.aborted) {
        const exit = await this.runtime.execute(run, ip, limits, controller.signal, () => this.store.heartbeat(run));
        resultDirectory = exit.resultDirectory;
        if (exit.exitCode !== 0) code ??= 'k6_execution_failed';
      }
      if (shutdown?.aborted) code = 'worker_shutdown';
    } catch (error) {
      if (error instanceof RuntimeNotStoppedError) stopped = false;
      code = code ?? failureCode(error);
    } finally {
      clearInterval(heartbeat); shutdown?.removeEventListener('abort', abort);
      if (stopped) {
        // Runtime setup/attachment can throw after creating output. Record its
        // directory even on failure so deletion can remove every staged byte.
        if (!resultDirectory) {
          const captured = join(stagingRoot(this.config), run.id);
          try { await access(captured); resultDirectory = captured; } catch { /* No captured output. */ }
        }
        await this.store.finish(run, code, resultDirectory);
      }
      // Unknown container state retains its running/cancelling reservation.
      // The recovery loop must stop it before marking the run terminal.
    }
  }

  async recoverOne(): Promise<boolean> {
    const orphan = await this.store.fenceOrphan(this.hostId);
    if (!orphan) return false;
    if (await this.runtime.stop(orphan.id)) {
      const directory = join(stagingRoot(this.config), orphan.id);
      let exists = false;
      try { await access(directory); exists = true; } catch { /* No captured output before worker failure. */ }
      await this.store.finish(orphan, orphan.failure_code, exists ? directory : undefined);
    }
    return true;
  }
}
