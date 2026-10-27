import { NavLink, Outlet } from 'react-router-dom';

export default function Layout() {
  return (
    <>
      <header className="site-header">
        <NavLink to="/" className="brand">
          Marketplace
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/status">System status</NavLink>
        </nav>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}