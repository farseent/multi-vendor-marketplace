import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Layout() {
  const { status, user } = useAuth();
  const navigate = useNavigate();

  return (
    <>
      <header className="site-header">
        <NavLink to="/" className="brand">
          Marketplace
        </NavLink>
        <form
          className="header-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const q = new FormData(event.currentTarget).get('q').toString().trim();
            navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
          }}
        >
          <input
            name="q"
            type="search"
            placeholder="Search products"
            aria-label="Search products"
            maxLength={100}
          />
          <button type="submit">Search</button>
        </form>
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
