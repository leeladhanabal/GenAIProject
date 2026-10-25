import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../api/src/database/database.service';
import { readRunLimits, RUN_QUEUE } from '../../api/src/runs/run-domain';
import { DockerK6Runtime } from './docker-k6-runtime';
import { OutboxDispatcher, RunPublisher } from './outbox-dispatcher';
import { RunProcessor } from './run-processor';
import { RunStore } from './run-store';

export class BullMqRunPublisher implements RunPublisher {
  constructor(private readonly queue: Queue) {}
  async publish(runId: string): Promise<void> {
    const previous = await this.queue.getJob(runId);
    // Only the dispatcher's still-queued DB rows reach this method. A terminal
    // queue record left by a pre-claim failure can therefore be replaced safely.
    if (previous && ['completed', 'failed'].includes(await previous.getState())) await previous.remove();
    await this.queue.add('execute', { runId }, { jobId: runId, attempts: 1,
      removeOnComplete: false, removeOnFail: false });
  }
}

async function main(): Promise<void> {
  const config = new ConfigService();
  const limits = readRunLimits(config);
  const redisUrl = config.get<string>('REDIS_URL');
  const hostId = config.get<string>('WORKER_HOST_ID')?.trim();
  if (!redisUrl || !hostId || hostId.length > 100) throw new Error('Configure REDIS_URL and a stable WORKER_HOST_ID');
  const runtime = new DockerK6Runtime(config);
  await runtime.ready();
  const database = new DatabaseService();
  const publisherConnection = new IORedis(redisUrl, { maxRetriesPerRequest: 1,
    enableOfflineQueue: false, connectTimeout: 3000, commandTimeout: 3000 });
  const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  publisherConnection.on('error', () => {});
  workerConnection.on('error', () => {});
  const queue = new Queue(RUN_QUEUE, { connection: publisherConnection });
  queue.on('error', () => {});
  const store = new RunStore(database);
  const processor = new RunProcessor(store, runtime, config, hostId);
  const dispatcher = new OutboxDispatcher(database, new BullMqRunPublisher(queue));
  const shutdown = new AbortController();
  const worker = new Worker(RUN_QUEUE, async (job) => {
    const runId: unknown = job.data?.runId;
    if (typeof runId !== 'string' || runId !== job.id || !/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('invalid_run_job');
    await processor.process(runId, shutdown.signal);
  }, { connection: workerConnection, concurrency: limits.maxConcurrentRuns, maxStalledCount: 0 });
  worker.on('error', () => { console.error('Worker queue connection error; durable runs remain in PostgreSQL.'); });
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log('Phase 4 worker started. No test runs are created by startup.');
  try {
    while (!shutdown.signal.aborted) {
      try {
        await processor.recoverOne();
        for (let i = 0; i < 5 && !shutdown.signal.aborted; i++) {
          if (!await dispatcher.dispatchOne()) break;
        }
      } catch { console.error('Worker reconciliation is unavailable; it will retry.'); }
      try { await delay(1000, undefined, { signal: shutdown.signal }); } catch { break; }
    }
  } finally {
    await worker.close(); await queue.close();
    publisherConnection.disconnect(); workerConnection.disconnect();
    await database.onModuleDestroy();
  }
}

if (require.main === module) void main().catch(() => {
  console.error('Worker startup failed. Check run policy, Redis, PostgreSQL, and worker configuration.');
  process.exitCode = 1;
});
