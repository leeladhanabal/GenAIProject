export interface ScriptDefinition {
  targetId: string;
  baseUrl: string;
  workload: { virtualUsers: number; durationSeconds: number };
  scenarios: Array<{ name: string; method: string; path: string; expectedStatus: number }>;
}

export interface PlanVersion {
  version: number;
  requirementsText: string;
  specification: unknown;
  script: null | {
    content: string;
    sha256: string;
    definition: ScriptDefinition;
    validationStatus: 'valid';
    reviewStatus: 'pending' | 'reviewed';
  };
}

export interface Plan {
  id: string;
  name: string;
  currentVersion: number;
  versions: PlanVersion[];
}

export async function api<T>(path: string, body?: unknown, headers: Record<string, string> = {}, method?: 'PUT'): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error?.message ?? 'Request failed');
  }
  return response.json() as Promise<T>;
}
