import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ErrorState, PageLoading } from '../components/ui';
import { buttonClasses } from '../components/ui/classes.js';
import { getAccessDecision } from './access.js';
import { useAuth } from './AuthContext.jsx';

/** Wrap routes that need a logged-in user, optionally limited to some roles. */
export default function ProtectedRoute({ roles }) {
  const { status, user } = useAuth();
  const location = useLocation();

  switch (getAccessDecision({ status, user, roles })) {
    case 'loading':
      return <PageLoading />;
    case 'login':
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    case 'forbidden':
      return (
        <div className="mx-auto max-w-xl px-4 py-16">
          <ErrorState
            title="You do not have access to this page"
            message="This area is limited to a different type of account."
            action={
              <Link to="/" className={buttonClasses({ variant: 'secondary' })}>
                Go to the home page
              </Link>
            }
          />
        </div>
      );
    default:
      return <Outlet />;
  }
}