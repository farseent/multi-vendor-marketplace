import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getAccessToken, refreshSession, setAccessToken } from './api.js';

const ok = (data) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ success: true, data }),
});
const fail = (status, code, message = 'nope') => ({
  ok: false,
  status,
  headers: new Headers(),
  json: async () => ({ success: false, error: { code, message, requestId: 'req_1' } }),
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setAccessToken(null);
});
afterEach(() => vi.unstubAllGlobals());

const authHeader = (call) => fetchMock.mock.calls[call][1].headers.Authorization;

describe('apiFetch authentication', () => {
  it('sends no Authorization header without a token, and Bearer once one is set', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await apiFetch('/x');
    setAccessToken('abc');
    await apiFetch('/x');
    expect(authHeader(0)).toBeUndefined();
    expect(authHeader(1)).toBe('Bearer abc');
  });

  it('always sends credentials so the refresh cookie travels', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await apiFetch('/x');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('on TOKEN_EXPIRED: refreshes once, stores the new token and retries the request', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(ok({ accessToken: 'new', user: { id: '1' } }))
      .mockResolvedValueOnce(ok({ hello: 'world' }));

    const { data } = await apiFetch('/users/me');
    expect(data).toEqual({ hello: 'world' });
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/auth\/refresh$/);
    expect(getAccessToken()).toBe('new');
    expect(authHeader(2)).toBe('Bearer new');
  });

  it('does not retry forever: a second TOKEN_EXPIRED is surfaced', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(ok({ accessToken: 'new', user: {} }))
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'));
    await expect(apiFetch('/x')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the token and rejects when the refresh itself fails', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED'));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
  });

  it('does not refresh for other errors or when skipRefresh is set', async () => {
    fetchMock.mockResolvedValue(fail(401, 'TOKEN_EXPIRED'));
    await expect(apiFetch('/auth/login', { skipRefresh: true })).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
    fetchMock.mockResolvedValue(fail(403, 'FORBIDDEN'));
    await expect(apiFetch('/x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('refreshSession', () => {
  // Refresh tokens are single-use: parallel refreshes would trigger server-side reuse detection.
  it('shares one in-flight request between concurrent callers', async () => {
    let resolve;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = refreshSession();
    const b = refreshSession();
    resolve(ok({ accessToken: 't', user: { id: '1' } }));
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(ok({ accessToken: 't2', user: { id: '1' } }));
    await refreshSession(); // a later call makes a new request
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
