import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, refreshSession, setAccessToken } from '../lib/api.js';

const AuthContext = createContext(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

const ANONYMOUS = { status: 'anonymous', user: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null });

  // On every page load the in-memory token is gone, so ask the server to restore the session
  // from the refresh cookie. No cookie (or an expired one) just means "not logged in".
  useEffect(() => {
    let active = true;
    refreshSession()
      .then(({ user }) => active && setState({ status: 'authenticated', user }))
      .catch(() => active && setState(ANONYMOUS));
    return () => {
      active = false;
    };
  }, []);

  const startSession = useCallback(({ user, accessToken }) => {
    setAccessToken(accessToken);
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  const post = (path, body) => apiFetch(path, { method: 'POST', body, skipRefresh: true });

  const login = useCallback(
    async (credentials) => startSession((await post('/auth/login', credentials)).data),
    [startSession],
  );

  const register = useCallback(
    async (fields, { vendor = false } = {}) =>
      startSession((await post(vendor ? '/auth/register-vendor' : '/auth/register', fields)).data),
    [startSession],
  );

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      // Even if the call failed we drop the local session; the cookie is revoked server-side
      // on the next successful logout or simply expires.
      setAccessToken(null);
      setState(ANONYMOUS);
    }
  }, []);

  const value = useMemo(
    () => ({ ...state, login, register, logout }),
    [state, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
