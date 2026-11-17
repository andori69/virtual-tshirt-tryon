import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../services/api';

const NAV = [
  ['/owner', 'Overview'],
  ['/owner/products', 'Products'],
  ['/owner/products/new', 'Add New T-shirt'],
  ['/owner/inventory', 'Inventory'],
  ['/owner/calibration', 'Camera Calibration'],
  ['/owner/settings', 'Settings'],
] as const;

export default function OwnerLayout() {
  const navigate = useNavigate();
  const [user, setUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ username: string }>('/api/auth/me')
      .then((u) => setUser(u.username))
      .catch((e: ApiError) => (e.status === 401 ? navigate('/owner/login', { replace: true }) : setError(e.message)));
  }, [navigate]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/owner/login', { replace: true });
  };

  if (error) return <div className="owner-gate" role="alert"><p>{error}</p></div>;
  if (!user) return <div className="owner-gate"><p>Checking sign-in…</p></div>;

  return (
    <div className="owner">
      <nav className="sidebar" aria-label="Owner">
        <div className="brand">Fitting Room<span>Owner</span></div>
        <ul>
          {NAV.map(([to, label]) => (
            <li key={to}>
              <NavLink to={to} end>{label}</NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <span className="muted">Signed in as {user}</span>
          <button className="btn btn-ghost" onClick={logout}>Logout</button>
        </div>
      </nav>
      <main className="owner-main">
        <Outlet />
      </main>
    </div>
  );
}
