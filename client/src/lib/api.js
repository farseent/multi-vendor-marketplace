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

/**
 * Calls the API and unwraps the { success, data, meta } envelope.
 * Resolves to { data, meta }; rejects with ApiError.
 */
export async function apiFetch(path, { method = 'GET', body, headers, signal, baseUrl } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl ?? DEFAULT_BASE_URL}${path}`, {
      method,
      credentials: 'include', // refresh-token cookie (Phase 1)
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
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