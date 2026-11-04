import { Navigate, Route, Routes } from 'react-router-dom';
import AdminAnalyticsPage from './admin/AdminAnalyticsPage.jsx';
import AdminCouponsPage from './admin/AdminCouponsPage.jsx';
import AdminLayout from './admin/AdminLayout.jsx';
import AdminOrderPage from './admin/AdminOrderPage.jsx';
import AdminOrdersPage from './admin/AdminOrdersPage.jsx';
import AdminProductsPage from './admin/AdminProductsPage.jsx';
import AdminReviewsPage from './admin/AdminReviewsPage.jsx';
import AdminSettlementsPage from './admin/AdminSettlementsPage.jsx';
import AdminVendorsPage from './admin/AdminVendorsPage.jsx';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import VendorLayout from './components/VendorLayout.jsx';
import AccountPage from './pages/AccountPage.jsx';
import CartPage from './pages/CartPage.jsx';
import CheckoutPage from './pages/CheckoutPage.jsx';
import HomePage from './pages/HomePage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import OrderPage from './pages/OrderPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import ProductPage from './pages/ProductPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import StatusPage from './pages/StatusPage.jsx';
import VendorOrdersPage from './pages/VendorOrdersPage.jsx';
import VendorProductFormPage from './pages/VendorProductFormPage.jsx';
import VendorProductsPage from './pages/VendorProductsPage.jsx';
import VendorSettlementsPage from './pages/VendorSettlementsPage.jsx';
import VendorShopPage from './pages/VendorShopPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="register-vendor" element={<RegisterPage vendor />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="products/:slug" element={<ProductPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="account" element={<AccountPage />} />
        </Route>
        {/* UX only: the API enforces the customer role on every /cart, /checkout and /orders request. */}
        <Route element={<ProtectedRoute roles={['customer']} />}>
          <Route path="cart" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:orderId" element={<OrderPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      {/* Vendor and admin consoles have their own shell (sidebar), outside the storefront layout. */}
      {/* UX only: the API enforces the vendor role on every /vendor/* request. */}
      <Route element={<ProtectedRoute roles={['vendor']} />}>
        <Route element={<VendorLayout />}>
          <Route path="vendor/shop" element={<VendorShopPage />} />
          <Route path="vendor/products" element={<VendorProductsPage />} />
          <Route path="vendor/products/new" element={<VendorProductFormPage />} />
          <Route path="vendor/products/:productId" element={<VendorProductFormPage />} />
          <Route path="vendor/orders" element={<VendorOrdersPage />} />
          <Route path="vendor/settlements" element={<VendorSettlementsPage />} />
        </Route>
      </Route>
      {/* UX only: the API enforces the admin role on every /admin/* request. */}
      <Route element={<ProtectedRoute roles={['admin']} />}>
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="analytics" replace />} />
          <Route path="analytics" element={<AdminAnalyticsPage />} />
          <Route path="orders" element={<AdminOrdersPage />} />
          <Route path="orders/:orderId" element={<AdminOrderPage />} />
          <Route path="vendors" element={<AdminVendorsPage />} />
          <Route path="products" element={<AdminProductsPage />} />
          <Route path="reviews" element={<AdminReviewsPage />} />
          <Route path="coupons" element={<AdminCouponsPage />} />
          <Route path="settlements" element={<AdminSettlementsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
