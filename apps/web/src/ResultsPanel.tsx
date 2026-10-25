import { useEffect, useState } from 'react';
import { api } from './api';

interface Summary {
  source: string; requests: number; requestsPerSecond: number | null; errorRate: number | null;
  latencyMs: { p95: number | null; p99: number | null }; slaStatus: string; findings: string[];
}
interface ResultRun { runId: string; status: string; resultStatus: string; resultFailureCode: string | null; summary: Summary | null }
interface Report { id: string; format: string; artifactId: string }

export async function downloadArtifact(artifactId: string): Promise<void> {
  const link = await api<{ url: string }>(`/artifacts/${artifactId}/download-link`, {});
  const destination = new URL(link.url, window.location.origin);
  const response = await fetch(destination.pathname + destination.search, { cache: 'no-store' });
  if (!response.ok) throw new Error('Download expired or unavailable. Request a fresh link.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url;
  const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1];
  anchor.download = filename ?? `artifact-${artifactId}`; anchor.click(); URL.revokeObjectURL(url);
}

export function ResultsPanel({ runId }: { runId: string }) {
  const [run, setRun] = useState<ResultRun | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [result, items] = await Promise.all([
          api<ResultRun>(`/runs/${runId}`), api<{ items: Report[] }>(`/runs/${runId}/reports`),
        ]);
        if (active) { setRun(result); setReports(items.items); }
        if (['ready', 'failed'].includes(result.resultStatus) ||
          (result.resultStatus === 'unavailable' && ['completed', 'failed', 'cancelled'].includes(result.status))) clearInterval(timer);
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : 'Results unavailable'); }
    };
    const timer = setInterval(() => void refresh(), 3000); void refresh();
    return () => { active = false; clearInterval(timer); };
  }, [runId, refreshVersion]);
  const summary = run?.summary;
  return <section aria-labelledby="results"><h2 id="results">Results and reports</h2>
    <p>Processing: {run?.resultStatus ?? 'loading'}</p>
    {run?.resultFailureCode && <p>{run.resultFailureCode}</p>}
    {summary && <>
      {summary.source === 'fixture' && <p><strong>Synthetic fixture data. No load test was executed.</strong></p>}
      <table><tbody>
        <tr><th>HTTP requests</th><td>{summary.requests}</td></tr>
        <tr><th>Requests / second</th><td>{summary.requestsPerSecond?.toFixed(2) ?? 'Not measured'}</td></tr>
        <tr><th>Error rate</th><td>{summary.errorRate === null ? 'Not measured' : `${(summary.errorRate * 100).toFixed(2)}%`}</td></tr>
        <tr><th>p95 response time</th><td>{summary.latencyMs.p95 === null ? 'Not measured' : `${summary.latencyMs.p95} ms`}</td></tr>
        <tr><th>SLA status</th><td>{summary.slaStatus}</td></tr>
      </tbody></table>
      {summary.findings.map((finding) => <p key={finding}>{finding}</p>)}
    </>}
    {reports.map((report) => <button disabled={busy} key={report.id} onClick={() => {
      setBusy(true); void downloadArtifact(report.artifactId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Download failed')).finally(() => setBusy(false));
    }}>Download {report.format.toUpperCase()} report</button>)}
    {run?.resultStatus === 'failed' && <button disabled={busy} onClick={() => {
      setBusy(true); void api(`/runs/${runId}/results/retry`, {}).then(() => {
        setMessage('Result processing queued. This does not rerun the load test.'); setRefreshVersion((value) => value + 1);
      })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Retry failed')).finally(() => setBusy(false));
    }}>Retry result processing</button>}
    <p role="status">{message}</p>
  </section>;
}
