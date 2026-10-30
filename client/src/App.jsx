import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import AccountPage from './pages/AccountPage.jsx';
import HomePage from './pages/HomePage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import ProductPage from './pages/ProductPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import StatusPage from './pages/StatusPage.jsx';
import VendorProductFormPage from './pages/VendorProductFormPage.jsx';
import VendorProductsPage from './pages/VendorProductsPage.jsx';
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
        <Route path="products/:slug" element={<ProductPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="account" element={<AccountPage />} />
        </Route>
        {/* UX only: the API enforces the vendor role on every /vendor/* request. */}
        <Route element={<ProtectedRoute roles={['vendor']} />}>
          <Route path="vendor/shop" element={<VendorShopPage />} />
          <Route path="vendor/products" element={<VendorProductsPage />} />
          <Route path="vendor/products/new" element={<VendorProductFormPage />} />
          <Route path="vendor/products/:productId" element={<VendorProductFormPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
