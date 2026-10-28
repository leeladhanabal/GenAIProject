import { check } from 'k6';

export const options = {
  scenarios: {
    bounded: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '1s',
      gracefulStop: '0s',
    },
  },
  rps: 2,
  hosts: { 'example.test': '93.184.216.34' },
  dns: { ttl: 'inf', policy: 'onlyIPv4' },
  maxRedirects: 0,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export default function () {
  check(true, { 'k6 compatibility smoke test': (passed) => passed });
}

export function handleSummary(data) {
  return { '/tmp/summary.json': JSON.stringify(data) };
}
