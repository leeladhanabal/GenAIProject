import { ConfigService } from '@nestjs/config';
import { GroqPlanningAdapter } from './groq-planning.adapter';

const scenarios = [{ name: 'Health', method: 'GET', path: '/health', expectedStatus: 200 }];
const input = { requirementsText: 'GET /health should return HTTP 200.',
  specification: { openapi: '3.0.3', operations: [{ method: 'GET', path: '/health' }] } };

function completion(content: unknown = { scenarios }, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason,
    message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('GroqPlanningAdapter', () => {
  let adapter: GroqPlanningAdapter;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    adapter = new GroqPlanningAdapter(new ConfigService({ GROQ_API_KEY: 'test-only-key',
      GROQ_MODEL: 'llama-3.3-70b-versatile', GROQ_TIMEOUT_MS: '30000' }));
    // No tests contact the provider or spend tokens.
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(completion());
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('uses the documented Groq endpoint, configured model, JSON mode, and minimal input', async () => {
    const result = await adapter.generate({ ...input,
      accessToken: 'private-google-token', targetUrl: 'https://private-target.example',
    } as typeof input);
    expect(result).toEqual({ scenarios });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(request?.headers).toEqual({ Authorization: 'Bearer test-only-key', 'Content-Type': 'application/json' });
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(request?.body as string);
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_completion_tokens).toBe(4096);
    expect(JSON.parse(body.messages[1].content)).toEqual(input);
    expect(body.messages[0].content).toContain('untrusted requirements data');
    expect(request?.body).not.toContain('private-google-token');
    expect(request?.body).not.toContain('private-target.example');
    expect(request?.body).not.toContain('test-only-key');
  });

  it.each([
    { GROQ_API_KEY: '', GROQ_MODEL: 'llama-3.3-70b-versatile' },
    { GROQ_API_KEY: 'test-only-key', GROQ_MODEL: '' },
    { GROQ_API_KEY: 'test-only-key', GROQ_MODEL: 'llama-3.3-70b-versatile', GROQ_TIMEOUT_MS: '0' },
    { GROQ_API_KEY: 'test-only-key', GROQ_MODEL: 'llama-3.3-70b-versatile', GROQ_TIMEOUT_MS: '120001' },
  ])('fails before sending data when configuration is invalid: %p', async (config) => {
    adapter = new GroqPlanningAdapter(new ConfigService(config));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      response: { code: 'ai_provider_not_configured' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'not JSON',
    '```json\n{"scenarios":[]}\n```',
    { scenarios: [] },
    { scenarios, content: 'export default function () {}' },
    { scenarios: [{ ...scenarios[0], path: '//evil.example' }] },
    { scenarios: [{ ...scenarios[0], path: '/users/{id}' }] },
    { scenarios: [{ ...scenarios[0], headers: { Authorization: 'secret' } }] },
    { scenarios: [{ ...scenarios[0], expectedStatus: '200' }] },
    { scenarios: [{ ...scenarios[0], method: 'CONNECT' }] },
    { scenarios: [{ ...scenarios[0], path: '/invented' }] },
    { scenarios: [{ ...scenarios[0], method: 'DELETE' }] },
  ])('rejects invalid or unsafe output without retrying: %p', async (output) => {
    fetchMock.mockResolvedValueOnce(completion(output));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      response: { code: 'ai_output_invalid' }, status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'content_filter', 'tool_calls'])('rejects incomplete or refused output: %s', async (reason) => {
    fetchMock.mockResolvedValueOnce(completion({ scenarios }, reason));
    await expect(adapter.generate(input)).rejects.toMatchObject({ response: { code: 'ai_output_invalid' } });
  });

  it('rejects an invalid completion envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"choices":[]}'));
    await expect(adapter.generate(input)).rejects.toMatchObject({ response: { code: 'ai_output_invalid' } });
  });

  it('accepts concrete synthetic parameter values for a specified operation', async () => {
    fetchMock.mockResolvedValueOnce(completion({ scenarios: [{ ...scenarios[0], path: '/users/123' }] }));
    await expect(adapter.generate({ requirementsText: 'Read user 123 at GET /users/123.',
      specification: { openapi: '3.0.3', operations: [{ method: 'GET', path: '/users/{id}' }] } }))
      .resolves.toEqual({ scenarios: [{ ...scenarios[0], path: '/users/123' }] });
  });

  it.each([401, 403])('does not retry authentication/access errors or expose upstream diagnostics: %s', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('test-only-key and private prompt', { status }));
    const error = await adapter.generate(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ response: { code: 'ai_provider_authentication_failed' }, status: 503 });
    expect(JSON.stringify(error)).not.toContain('test-only-key');
    expect(JSON.stringify(error)).not.toContain('private prompt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient provider failures and accepts a subsequent valid completion', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 503 }))
      .mockResolvedValueOnce(completion());
    await expect(adapter.generate(input)).resolves.toEqual({ scenarios });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
  });

  it('bounds rate-limit retries to three attempts', async () => {
    fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      response: { code: 'ai_provider_rate_limited' }, status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps exhausted network failures without leaking the original exception', async () => {
    fetchMock.mockRejectedValue(new Error('network failed with private data'));
    const error = await adapter.generate(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ response: { code: 'ai_provider_unavailable' }, status: 503 });
    expect(JSON.stringify(error)).not.toContain('private data');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a timed-out request', async () => {
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    fetchMock.mockRejectedValue(new Error('aborted'));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      response: { code: 'ai_provider_timeout' }, status: 504,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unsupported model/request without retrying or exposing the response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('sensitive diagnostic', { status: 400 }));
    await expect(adapter.generate(input)).rejects.toMatchObject({
      response: { code: 'ai_provider_request_failed' }, status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
