const DEFAULT_BASE_URL = import.meta.env?.VITE_API_URL || '/api/v1';

/** Error thrown for every failed API call, shaped after the backend error envelope. */
export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

// The access token lives in memory only (ARCHITECTURE section 7): never localStorage, so an XSS
// bug cannot read it. A page reload loses it; AuthProvider gets a new one via the refresh cookie.
let accessToken = null;
export const setAccessToken = (token) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;

/** One HTTP call. Resolves to { data, meta }; rejects with ApiError. No auth handling here. */
async function send(path, { method = 'GET', body, headers, signal, baseUrl } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl ?? DEFAULT_BASE_URL}${path}`, {
      method,
      credentials: 'include', // sends the httpOnly refresh-token cookie
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the server' });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page): handled below.
  }

  if (!res.ok || payload?.success !== true) {
    const error = payload?.error;
    throw new ApiError({
      status: res.status,
      code: error?.code ?? 'UNKNOWN_ERROR',
      message: error?.message ?? `Request failed (${res.status})`,
      details: error?.details,
      requestId: error?.requestId ?? res.headers.get('X-Request-Id') ?? undefined,
    });
  }
  return { data: payload.data, meta: payload.meta };
}

// Refresh tokens are single-use, so two parallel refreshes would trip the server's reuse
// detection and log the user out. All callers share one in-flight request instead (this also
// covers React StrictMode running effects twice in development).
let refreshInFlight = null;

/** Exchanges the refresh cookie for a new access token. Resolves to { user, accessToken }. */
export function refreshSession() {
  refreshInFlight ??= send('/auth/refresh', { method: 'POST' })
    .then(({ data }) => {
      accessToken = data.accessToken;
      return data;
    })
    .catch((err) => {
      accessToken = null;
      throw err;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Calls the API and unwraps the { success, data, meta } envelope.
 * Adds the Bearer token when we have one; on TOKEN_EXPIRED it refreshes once and retries.
 * Pass `skipRefresh: true` for the auth endpoints themselves.
 */
export async function apiFetch(path, { skipRefresh = false, ...options } = {}) {
  try {
    return await send(path, options);
  } catch (err) {
    if (skipRefresh || err.code !== 'TOKEN_EXPIRED') throw err;
    await refreshSession(); // if this fails the caller sees that error (session is gone)
    return send(path, options);
  }
}
