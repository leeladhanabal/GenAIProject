import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface Scenario {
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
}

export interface Specification {
  openapi: string;
  operations: Array<{ method: string; path: string }>;
}

export interface ScriptInput {
  targetId: string;
  workload: { virtualUsers: number; durationSeconds: number };
  scenarios: Scenario[];
}

export interface ScriptDefinition extends ScriptInput {
  baseUrl: string;
}

function invalid(message: string): never {
  throw new BadRequestException({ code: 'planning_input_invalid', message });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is string {
  // Restrict requests to literal paths on the registered target. Resolve path
  // parameters in the editor; specifications never supply a destination URL.
  return typeof value === 'string' && value.length <= 2048 &&
    /^\/(?!\/)[A-Za-z0-9/_~.{}-]*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..');
}

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export function normalizeSpecification(value: unknown): Specification {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 100000) {
    return invalid('specification must be an OpenAPI JSON object under 100 KB');
  }
  if (typeof value.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(value.openapi) ||
      !record(value.paths)) {
    return invalid('specification must contain OpenAPI 3.0/3.1 and paths');
  }
  // No network fetching, reference resolution, examples, server URLs,
  // credentials, HTML, or free-form instructions are retained or sent to AI.
  const operations: Specification['operations'] = [];
  for (const [path, item] of Object.entries(value.paths)) {
    if (!validPath(path) || !record(item)) {
      return invalid('Specification paths must be relative literal API paths');
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.includes(method.toUpperCase()) || method !== method.toLowerCase()) continue;
      if (!record(operation)) return invalid('Invalid OpenAPI operation');
      operations.push({ method: method.toUpperCase(), path });
    }
  }
  if (!operations.length || operations.length > 100) {
    return invalid('specification must contain between 1 and 100 operations');
  }
  return { openapi: value.openapi, operations };
}

export function parseScriptInput(value: unknown): ScriptInput {
  if (!record(value) || Object.keys(value).some((key) =>
    !['targetId', 'workload', 'scenarios'].includes(key))) {
    return invalid('script requires targetId, workload, and scenarios only');
  }
  if (typeof value.targetId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.targetId)) {
    return invalid('script.targetId must be a UUID');
  }
  const workload = value.workload;
  if (!record(workload) || Object.keys(workload).length !== 2 ||
      !Number.isSafeInteger(workload.virtualUsers) || Number(workload.virtualUsers) < 1 ||
      !Number.isSafeInteger(workload.durationSeconds) || Number(workload.durationSeconds) < 1) {
    return invalid('workload requires positive integer virtualUsers and durationSeconds');
  }
  return { targetId: value.targetId, workload: {
    virtualUsers: Number(workload.virtualUsers), durationSeconds: Number(workload.durationSeconds),
  }, scenarios: parseScenarios(value.scenarios) };
}

export function parseScenarios(value: unknown): Scenario[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    return invalid('script must have between 1 and 100 scenarios');
  }
  return value.map((scenario: unknown): Scenario => {
    if (!record(scenario) || Object.keys(scenario).some((key) =>
      !['name', 'method', 'path', 'expectedStatus'].includes(key)) ||
      typeof scenario.name !== 'string' || !scenario.name.trim() || scenario.name.length > 100 ||
      typeof scenario.method !== 'string' || !methods.includes(scenario.method) ||
      !validPath(scenario.path) || /[{}]/.test(scenario.path) ||
      !Number.isInteger(scenario.expectedStatus) || Number(scenario.expectedStatus) < 100 ||
      Number(scenario.expectedStatus) > 599) {
      return invalid('Each scenario needs name, method, literal relative path, and expectedStatus (100–599)');
    }
    return { name: scenario.name.trim(), method: scenario.method, path: scenario.path,
      expectedStatus: Number(scenario.expectedStatus) };
  });
}

export function renderScript(definition: ScriptDefinition): { content: string; sha256: string } {
  // Compile a constrained model instead of accepting executable provider/user
  // JavaScript. Redirects and extra imports cannot be introduced by content.
  const input = parseScriptInput({ targetId: definition.targetId,
    workload: definition.workload, scenarios: definition.scenarios });
  const base = new URL(definition.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    return invalid('Script destination must be a registered HTTPS target');
  }
  const requests = input.scenarios.map((scenario) => {
    const url = new URL(scenario.path.slice(1), base.href.endsWith('/') ? base : `${base.href}/`);
    if (url.origin !== base.origin) return invalid('Scenario escaped the target origin');
    return `  {\n    const response = http.request(${JSON.stringify(scenario.method)}, ${JSON.stringify(url.href)}, null, { redirects: 0 });\n    check(response, { [${JSON.stringify(scenario.name)}]: (r) => r.status === ${scenario.expectedStatus} });\n  }`;
  });
  const content = `// Review this script and obtain explicit run approval before execution.\nimport http from 'k6/http';\nimport { check, sleep } from 'k6';\n\nexport const options = ${JSON.stringify({ vus: input.workload.virtualUsers, duration: `${input.workload.durationSeconds}s`, maxRedirects: 0 }, null, 2)};\n\nexport default function () {\n${requests.join('\n')}\n  sleep(1);\n}\n`;
  return { content, sha256: createHash('sha256').update(content).digest('hex') };
}
