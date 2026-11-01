import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { CART_KEY, fetchCart } from '../lib/cart.js';

// Customers only: the cart API answers 403 to other roles, so this is not even rendered for them.
function CartLink() {
  const { data } = useQuery({ queryKey: CART_KEY, queryFn: fetchCart, staleTime: 30_000 });
  return <NavLink to="/cart">Cart{data?.itemCount ? ` (${data.itemCount})` : ''}</NavLink>;
}

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
          {user?.role === 'customer' && <CartLink />}
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
