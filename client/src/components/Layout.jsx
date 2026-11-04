import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { CART_KEY, fetchCart } from '../lib/cart.js';
import Footer from './Footer.jsx';
import { Button, Container, Icon, LinkButton, SearchBar } from './ui';
import { cx } from './ui/classes.js';

const navLinkClass = ({ isActive }) =>
  cx(
    'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors lg:min-h-10',
    isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  );

// Customers only: the cart API answers 403 to other roles, so this is not even rendered for them.
function CartLink({ onNavigate }) {
  const { data } = useQuery({ queryKey: CART_KEY, queryFn: fetchCart, staleTime: 30_000 });
  const count = data?.itemCount ?? 0;
  return (
    <NavLink to="/cart" className={navLinkClass} onClick={onNavigate}>
      <Icon name="cart" className="size-4.5" />
      Cart
      {count > 0 && (
        <span className="tabular grid min-w-5 place-items-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold leading-5 text-white">
          {count}
          <span className="sr-only"> {count === 1 ? 'item' : 'items'}</span>
        </span>
      )}
    </NavLink>
  );
}

function NavItems({ onNavigate }) {
  const { status, user } = useAuth();
  return (
    <>
      <NavLink to="/search" className={navLinkClass} onClick={onNavigate}>
        <Icon name="search" className="size-4.5" />
        Browse
      </NavLink>
      {user?.role === 'customer' && <CartLink onNavigate={onNavigate} />}
      {user?.role === 'customer' && (
        <NavLink to="/orders" className={navLinkClass} onClick={onNavigate}>
          <Icon name="receipt" className="size-4.5" />
          Orders
        </NavLink>
      )}
      {user?.role === 'vendor' && (
        <NavLink to="/vendor/shop" className={navLinkClass} onClick={onNavigate}>
          <Icon name="store" className="size-4.5" />
          Seller dashboard
        </NavLink>
      )}
      {user?.role === 'admin' && (
        <NavLink to="/admin" className={navLinkClass} onClick={onNavigate}>
          <Icon name="grid" className="size-4.5" />
          Admin console
        </NavLink>
      )}
      {status === 'authenticated' ? (
        <NavLink to="/account" className={navLinkClass} onClick={onNavigate}>
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-full bg-brand-600 text-xs font-semibold uppercase text-white"
          >
            {user.name?.[0]}
          </span>
          <span className="max-w-32 truncate">{user.name}</span>
        </NavLink>
      ) : (
        status === 'anonymous' && (
          <>
            <NavLink to="/login" className={navLinkClass} onClick={onNavigate}>
              Log in
            </NavLink>
            <LinkButton to="/register" size="sm" onClick={onNavigate}>
              Sign up
            </LinkButton>
          </>
        )
      )}
    </>
  );
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-60 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-float"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <Container className="flex h-16 items-center gap-4">
          <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Marketplace home">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white shadow-sm">
              <Icon name="store" className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-slate-900">Marketplace</span>
          </Link>
          <SearchBar className="mx-auto hidden max-w-xl flex-1 lg:flex" />
          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 lg:flex">
            <NavItems />
          </nav>
          <Button
            variant="ghost"
            className="ml-auto size-11 px-0! lg:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Icon name={menuOpen ? 'x' : 'menu'} />
          </Button>
        </Container>
        <div className="border-t border-slate-100 px-4 py-2.5 lg:hidden">
          <SearchBar />
        </div>
        {menuOpen && (
          <nav
            id="mobile-menu"
            aria-label="Main"
            className="flex flex-col gap-1 border-t border-slate-100 px-4 py-3 lg:hidden"
          >
            <NavItems onNavigate={closeMenu} />
          </nav>
        )}
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}