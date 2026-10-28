import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getAccessDecision } from './access.js';
import { useAuth } from './AuthContext.jsx';

/** Wrap routes that need a logged-in user, optionally limited to some roles. */
export default function ProtectedRoute({ roles }) {
  const { status, user } = useAuth();
  const location = useLocation();

  switch (getAccessDecision({ status, user, roles })) {
    case 'loading':
      return <p>Loading…</p>;
    case 'login':
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    case 'forbidden':
      return <p role="alert">You do not have access to this page.</p>;
    default:
      return <Outlet />;
  }
}
