import { useEffect, useRef, useState } from 'react';
import { api, type PlanVersion } from './api';
import { ResultsPanel } from './ResultsPanel';

interface RunLimits {
  maxVirtualUsers: number; maxDurationSeconds: number; maxConcurrentRuns: number;
  maxRequestsPerSecond: number; maxRequestsPerRun: number;
}
interface Run {
  runId: string; status: string; createdAt: string; startedAt: string | null;
  completedAt: string | null; failureCode: string | null;
}
const terminal = ['completed', 'failed', 'cancelled'];

export function RunPanel({ planId, version }: { planId: string; version: PlanVersion }) {
  const [limits, setLimits] = useState<RunLimits | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [lookupId, setLookupId] = useState('');
  const pendingKey = useRef<string | null>(null);
  const script = version.script;

  useEffect(() => {
    let active = true;
    void api<RunLimits>(`/plans/${planId}/run-policy`).then((value) => {
      if (active) setLimits(value);
    }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Could not load run limits'); });
    return () => { active = false; };
  }, [planId]);

  useEffect(() => {
    if (!run || terminal.includes(run.status)) return;
    const runId = run.runId;
    let active = true;
    const timer = setInterval(() => {
      void api<Run>(`/runs/${runId}`).then((value) => { if (active) setRun(value); })
        .catch((error: unknown) => {
          clearInterval(timer);
          if (active) setMessage(error instanceof Error ? error.message : 'Status refresh failed');
        });
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [run?.runId, run?.status]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="runs"><h2 id="runs">Approve and monitor a run</h2>
    {script && <><p><strong>Target:</strong> {script.definition.baseUrl}</p>
      <p><strong>Reviewed workload:</strong> {script.definition.workload.virtualUsers} virtual users,
        {' '}{script.definition.workload.durationSeconds} seconds maximum, version {version.version}.</p></>}
    {limits && <p>Ceilings: {limits.maxVirtualUsers} virtual users, {limits.maxDurationSeconds} seconds,
      {' '}{limits.maxRequestsPerSecond} requests/second, {limits.maxRequestsPerRun} total requests,
      {' '}{limits.maxConcurrentRuns} active or queued runs across the service.</p>}
    {script?.reviewStatus !== 'reviewed' && <p>Record a review of this saved script before approving a run.</p>}
    <label className="check"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
      I am authorized to load test this target.</label>
    <label className="check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
      I approve this specific workload and run.</label>
    <button disabled={busy || !limits || !authorized || !approved || script?.reviewStatus !== 'reviewed'}
      onClick={() => void action(async () => {
        if (!script) return;
        pendingKey.current ??= crypto.randomUUID();
        const result = await api<Run>(`/plans/${planId}/runs`, {
          targetId: script.definition.targetId, planVersion: version.version, workload: script.definition.workload,
          authorizationConfirmed: true, approved: true,
        }, { 'Idempotency-Key': pendingKey.current });
        setRun(result); setLookupId(result.runId); pendingKey.current = null;
        setAuthorized(false); setApproved(false);
      })}>Approve and queue run</button>
    <div role="status" aria-live="polite">{message}</div>
    <label>Run ID<input value={lookupId} onChange={(event) => setLookupId(event.target.value)} /></label>
    <button disabled={busy || !lookupId} onClick={() => void action(async () => setRun(await api<Run>(`/runs/${lookupId}`)))}>Refresh run status</button>
    {run && <><p><strong>Run {run.runId}:</strong> {run.status}</p>
      <p>Queued: {run.createdAt}{run.startedAt && ` · Started: ${run.startedAt}`}{run.completedAt && ` · Finished: ${run.completedAt}`}</p>
      {run.failureCode && <p>Failure code: {run.failureCode}</p>}
      <button disabled={busy || !['queued', 'running'].includes(run.status)} onClick={() => void action(async () => {
        setRun(await api<Run>(`/runs/${run.runId}/cancel`, {}));
      })}>Cancel run</button>
    </>}
    {run && <ResultsPanel key={run.runId} runId={run.runId} />}
  </section>;
}
