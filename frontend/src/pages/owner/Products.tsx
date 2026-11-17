import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/common';
import { api, formatPrice } from '../../services/api';
import type { ProductSummary } from '../../types';

const FILTERS = [['', 'All active'], ['draft', 'Drafts'], ['published', 'Published'], ['archived', 'Archived']] as const;

export default function Products() {
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState<ProductSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    api<ProductSummary[]>(`/api/owner/products${filter ? `?status=${filter}` : ''}`)
      .then((all) => setItems(filter ? all : all.filter((p) => p.status !== 'archived')))
      .catch((e) => setError(e.message));
  }, [filter]);

  return (
    <>
      <header className="page-head">
        <h1>Products</h1>
        <Link className="btn btn-primary" to="/owner/products/new">Add New T-shirt</Link>
      </header>
      <div className="tabs" role="tablist">
        {FILTERS.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'is-active' : ''}
            onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!items ? <p className="muted">Loading…</p> : items.length === 0 ? (
        <p className="muted card">No products here yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th /><th>Name</th><th>Status</th><th>Colors</th><th>Sizes</th><th>Stock</th><th>Price</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.thumb_url ? <img className="table-thumb" src={p.thumb_url} alt="" /> : <span className="thumb-empty" />}</td>
                <td><Link to={`/owner/products/${p.id}`}>{p.name}</Link>{p.brand && <div className="muted small">{p.brand}</div>}</td>
                <td><StatusBadge status={p.status} /></td>
                <td>{p.colors.join(', ') || '—'}</td>
                <td>{p.sizes.join(' ') || '—'}</td>
                <td>{p.total_stock}</td>
                <td>{formatPrice(p.price, p.currency)}</td>
                <td className="muted small">{new Date(p.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
