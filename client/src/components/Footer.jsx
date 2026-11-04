import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Container, Icon } from './ui';

const linkClass = 'text-sm text-slate-400 transition-colors hover:text-white';

/** Site footer. Every link goes to a page that exists. */
export default function Footer() {
  const { status, user } = useAuth();
  return (
    <footer className="mt-16 bg-slate-900 text-slate-300">
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white">
              <Icon name="store" className="size-5" />
            </span>
            <span className="text-lg font-semibold text-white">Marketplace</span>
          </Link>
          <p className="mt-4 max-w-xs text-sm text-slate-400">
            Shop from many independent sellers and pay once. Each seller ships their own part of
            your order.
          </p>
        </div>
        <nav aria-label="Shop">
          <h2 className="text-sm font-semibold text-white">Shop</h2>
          <ul className="mt-4 space-y-2.5">
            <li>
              <Link to="/search" className={linkClass}>
                All products
              </Link>
            </li>
            <li>
              <Link to="/search?sort=-createdAt" className={linkClass}>
                New arrivals
              </Link>
            </li>
            <li>
              <Link to="/search?sort=-ratingAvg" className={linkClass}>
                Top rated
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Sell">
          <h2 className="text-sm font-semibold text-white">Sell</h2>
          <ul className="mt-4 space-y-2.5">
            <li>
              <Link to={user?.role === 'vendor' ? '/vendor/shop' : '/register-vendor'} className={linkClass}>
                {user?.role === 'vendor' ? 'Seller dashboard' : 'Become a seller'}
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="text-sm font-semibold text-white">Account</h2>
          <ul className="mt-4 space-y-2.5">
            {status === 'authenticated' ? (
              <li>
                <Link to="/account" className={linkClass}>
                  Your account
                </Link>
              </li>
            ) : (
              <>
                <li>
                  <Link to="/login" className={linkClass}>
                    Log in
                  </Link>
                </li>
                <li>
                  <Link to="/register" className={linkClass}>
                    Create an account
                  </Link>
                </li>
              </>
            )}
            <li>
              <Link to="/status" className={linkClass}>
                System status
              </Link>
            </li>
          </ul>
        </nav>
      </Container>
      <div className="border-t border-white/10">
        <Container className="py-5 text-xs text-slate-500">
          © {new Date().getFullYear()} Marketplace. All rights reserved.
        </Container>
      </div>
    </footer>
  );
}