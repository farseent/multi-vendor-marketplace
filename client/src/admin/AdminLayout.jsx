import { NavLink, Outlet } from 'react-router-dom';
import './admin.css';

const LINKS = [
  ['analytics', 'Analytics'],
  ['orders', 'Orders'],
  ['vendors', 'Vendors'],
  ['products', 'Products'],
  ['reviews', 'Reviews'],
  ['coupons', 'Coupons'],
  ['settlements', 'Settlements'],
];

/** Shell of the admin console: a sub-navigation and the page below it. UX only; the API checks the role. */
export default function AdminLayout() {
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        {LINKS.map(([path, label]) => (
          <NavLink key={path} to={`/admin/${path}`}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
