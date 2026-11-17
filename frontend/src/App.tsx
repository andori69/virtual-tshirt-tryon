import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Kiosk from './pages/customer/Kiosk';
import Calibration from './pages/owner/Calibration';
import Inventory from './pages/owner/Inventory';
import Login from './pages/owner/Login';
import Overview from './pages/owner/Overview';
import OwnerLayout from './pages/owner/OwnerLayout';
import ProductEditor from './pages/owner/ProductEditor';
import Products from './pages/owner/Products';
import SettingsPage from './pages/owner/Settings';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Kiosk />} />
      <Route path="/owner/login" element={<Login />} />
      <Route path="/owner" element={<OwnerLayout />}>
        <Route index element={<Overview />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductEditor />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="calibration" element={<Calibration />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
