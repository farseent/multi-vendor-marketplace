import DashboardLayout from '../components/DashboardLayout.jsx';

const LINKS = [
  { to: '/admin/analytics', label: 'Analytics', icon: 'chart' },
  { to: '/admin/orders', label: 'Orders', icon: 'receipt' },
  { to: '/admin/vendors', label: 'Vendors', icon: 'store' },
  { to: '/admin/products', label: 'Products', icon: 'package' },
  { to: '/admin/reviews', label: 'Reviews', icon: 'message' },
  { to: '/admin/coupons', label: 'Coupons', icon: 'tag' },
  { to: '/admin/settlements', label: 'Settlements', icon: 'wallet' },
];

/** Shell of the admin console: sidebar plus the page. UX only; the API checks the role. */
export default function AdminLayout() {
  return <DashboardLayout title="Admin console" links={LINKS} tone="dark" />;
}
