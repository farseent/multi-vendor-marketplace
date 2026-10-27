import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api.js';

function mockFetch(response) {
  const fn = vi.fn(async () => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('unwraps data and meta from the success envelope', async () => {
    const fetchMock = mockFetch(jsonResponse({ success: true, data: { a: 1 }, meta: { page: 1 } }));
    const result = await apiFetch('/things', { baseUrl: '/api/v1' });
    expect(result).toEqual({ data: { a: 1 }, meta: { page: 1 } });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/things');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('sends JSON bodies with a content type', async () => {
    const fetchMock = mockFetch(jsonResponse({ success: true, data: {} }));
    await apiFetch('/x', { method: 'POST', body: { n: 1 }, baseUrl: '/api/v1' });
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe('{"n":1}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('rejects with ApiError built from the error envelope', async () => {
    mockFetch(
      jsonResponse(
        { success: false, error: { code: 'NOT_FOUND', message: 'Nope', requestId: 'req_1' } },
        { status: 404 },
      ),
    );
    const err = await apiFetch('/missing').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Nope',
      requestId: 'req_1',
    });
  });

  it('handles non-JSON error responses (e.g. proxy errors)', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await apiFetch('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' });
  });

  it('wraps network failures as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await apiFetch('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});