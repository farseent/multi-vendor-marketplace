import DashboardLayout from './DashboardLayout.jsx';

const LINKS = [
  { to: '/vendor/shop', label: 'My shop', icon: 'store' },
  { to: '/vendor/products', label: 'My products', icon: 'package' },
  { to: '/vendor/orders', label: 'Orders', icon: 'receipt' },
  { to: '/vendor/settlements', label: 'Payouts', icon: 'wallet' },
];

/** Shell of the seller dashboard: sidebar plus the page. UX only; the API checks the role. */
export default function VendorLayout() {
  return <DashboardLayout title="Seller dashboard" links={LINKS} maxWidth="max-w-5xl" />;
}
