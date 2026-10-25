import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../api/src/database/database.service';
import { createArtifactStorage } from '../../api/src/artifacts/artifact-storage';
import { ResultPipeline } from '../../api/src/results/result-pipeline';
import { LifecycleProcessor } from '../../api/src/retention/lifecycle-processor';

async function main(): Promise<void> {
  const config = new ConfigService();
  const host = config.get<string>('WORKER_HOST_ID')?.trim();
  if (!host) throw new Error('Configure WORKER_HOST_ID');
  const storage = createArtifactStorage(config);
  const database = new DatabaseService();
  const pipeline = new ResultPipeline(database, storage, config, host);
  const lifecycle = new LifecycleProcessor(database, storage, config, host);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  console.log('Phase 5 processing started. It never executes load tests.');
  try {
    while (!stop.signal.aborted) {
      try {
        await pipeline.processOne();
        await lifecycle.deleteProjectOne();
        await lifecycle.scheduleNoticeOne();
        await lifecycle.deliverEmailOne();
        await lifecycle.deleteExpiredOne();
      } catch { console.error('Phase 5 processing is unavailable; pending jobs will be retried.'); }
      try { await delay(1000, undefined, { signal: stop.signal }); } catch { break; }
    }
  } finally { await database.onModuleDestroy(); }
}
if (require.main === module) void main().catch(() => {
  console.error('Phase 5 startup failed. Check database, local storage, and worker configuration.'); process.exitCode = 1;
});
