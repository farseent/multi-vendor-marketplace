import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Layout() {
  const { status, user } = useAuth();

  return (
    <>
      <header className="site-header">
        <NavLink to="/" className="brand">
          Marketplace
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/status">System status</NavLink>
          {user?.role === 'vendor' && (
            <>
              <NavLink to="/vendor/shop">My shop</NavLink>
              <NavLink to="/vendor/products">My products</NavLink>
            </>
          )}
          {status === 'authenticated' ? (
            <NavLink to="/account">{user.name}</NavLink>
          ) : (
            status === 'anonymous' && (
              <>
                <NavLink to="/login">Log in</NavLink>
                <NavLink to="/register">Sign up</NavLink>
              </>
            )
          )}
        </nav>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
