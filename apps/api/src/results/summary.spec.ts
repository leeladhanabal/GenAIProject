import { htmlReport, summarizeK6 } from './summary';

describe('Result summary normalization and reports', () => {
  it('supports the versioned k6 machine-readable schema without inventing absent measurements', () => {
    const value = { version: '1.0.0', config: { duration: 5 }, results: { metrics: [
      { name: 'http_reqs', values: { count: 10 } }, { name: 'http_req_duration', values: { 'p(95)': 120 } },
      { name: 'http_req_failed', values: { rate: 0.1 } },
    ], checks: { metrics: [{ name: 'checks_succeeded', values: { rate: 0.9 } }] } } };
    expect(summarizeK6(value, { p95ResponseTimeMs: 150, maxErrorRate: 0.05 })).toMatchObject({
      requests: 10, requestsPerSecond: 2, durationMs: 5000, checkPassRate: 0.9,
      latencyMs: { p95: 120, p99: null, average: null }, slaStatus: 'failed',
    });
  });
  it('keeps missing metrics unknown and never reports a configured SLA passed without data', () => {
    expect(summarizeK6({ metrics: { http_reqs: { values: { count: 0 } } } }, { p95ResponseTimeMs: 200 }))
      .toMatchObject({ requests: 0, requestsPerSecond: null, errorRate: null, slaStatus: 'incomplete' });
  });
  it.each([null, {}, { metrics: { http_reqs: { count: -1 } } },
    { metrics: { http_reqs: { count: 2 }, http_req_failed: { rate: 2 } } }])('rejects malformed summary data (%p)', (value) => {
      expect(() => summarizeK6(value)).toThrow('invalid_k6_summary');
    });
  it('escapes untrusted text in downloadable HTML', () => {
    const summary = summarizeK6({ metrics: { http_reqs: { count: 1 } } });
    summary.findings.push('<script>alert(1)</script>');
    const html = htmlReport('<img src=x onerror=alert(1)>', summary);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});
