export interface SlaThresholds { p95ResponseTimeMs?: number; maxErrorRate?: number }
export interface ResultSummary {
  source: 'k6' | 'fixture'; requests: number; requestsPerSecond: number | null;
  errorRate: number | null; checkPassRate: number | null;
  latencyMs: { average: number | null; median: number | null; p95: number | null; p99: number | null };
  durationMs: number | null; slaStatus: 'passed' | 'failed' | 'not_configured' | 'incomplete';
  slaThresholds: SlaThresholds; findings: string[];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numeric(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

export function summarizeK6(value: unknown, thresholds: SlaThresholds = {}, source: 'k6' | 'fixture' = 'k6'): ResultSummary {
  if (!object(value)) throw new Error('invalid_k6_summary');
  let metrics: Record<string, unknown>;
  let durationMs: number | null;
  if (object(value.metrics)) {
    metrics = value.metrics;
    durationMs = object(value.state) ? numeric(value.state.testRunDurationMs) : null;
  } else if (value.version === '1.0.0' && object(value.results) && Array.isArray(value.results.metrics)) {
    metrics = Object.create(null) as Record<string, unknown>;
    const checks = object(value.results.checks) && Array.isArray(value.results.checks.metrics) ? value.results.checks.metrics : [];
    for (const metric of [...value.results.metrics, ...checks]) {
      if (!object(metric) || typeof metric.name !== 'string' || !object(metric.values)) throw new Error('invalid_k6_summary');
      if (Object.hasOwn(metrics, metric.name)) throw new Error('invalid_k6_summary');
      metrics[metric.name] = metric;
    }
    const seconds = object(value.config) ? numeric(value.config.duration) : null;
    durationMs = seconds === null ? null : seconds * 1000;
  } else throw new Error('invalid_k6_summary');
  const values = (name: string): Record<string, unknown> => {
    const metric = metrics[name];
    return object(metric) ? (object(metric.values) ? metric.values : metric) : {};
  };
  const requests = numeric(values('http_reqs').count);
  if (requests === null || !Number.isInteger(requests)) throw new Error('invalid_k6_summary');
  const errorRate = numeric(values('http_req_failed').rate);
  const checkPassRate = numeric(values('checks').rate) ?? numeric(values('checks_succeeded').rate);
  if ((errorRate !== null && errorRate > 1) || (checkPassRate !== null && checkPassRate > 1)) throw new Error('invalid_k6_summary');
  const latency = values('http_req_duration');
  const p95 = numeric(latency['p(95)']);
  const verdicts: Array<boolean | null> = [];
  if (thresholds.p95ResponseTimeMs !== undefined) verdicts.push(p95 === null ? null : p95 <= thresholds.p95ResponseTimeMs);
  if (thresholds.maxErrorRate !== undefined) verdicts.push(errorRate === null ? null : errorRate <= thresholds.maxErrorRate);
  const slaStatus = verdicts.length === 0 ? 'not_configured' : verdicts.includes(false) ? 'failed' : verdicts.includes(null) ? 'incomplete' : 'passed';
  return { source, requests, requestsPerSecond: numeric(values('http_reqs').rate) ?? (durationMs && durationMs > 0 ? requests * 1000 / durationMs : null), errorRate, checkPassRate,
    latencyMs: { average: numeric(latency.avg), median: numeric(latency.med), p95, p99: numeric(latency['p(99)']) },
    durationMs,
    slaStatus, slaThresholds: thresholds,
    findings: [source === 'fixture' ? 'Synthetic fixture data; no load test was executed.' : 'Measured k6 output; no AI-generated metrics.',
      `Recorded ${requests} HTTP requests.`, `SLA status: ${slaStatus}.`],
  };
}

export function htmlReport(runId: string, summary: ResultSummary): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Performance report</title><h1>Performance report</h1><p>Run ${escape(runId)}</p><pre>${escape(JSON.stringify(summary, null, 2))}</pre></html>`;
}
