/**
 * Pure routing decision for ProtectedRoute, kept separate so it is easy to test.
 * Returns 'loading' | 'login' | 'forbidden' | 'allow'.
 * This is only UX: the API enforces roles on every request regardless of what the UI shows.
 */
export function getAccessDecision({ status, user, roles }) {
  if (status === 'loading') return 'loading';
  if (status !== 'authenticated' || !user) return 'login';
  if (roles?.length && !roles.includes(user.role)) return 'forbidden';
  return 'allow';
}
