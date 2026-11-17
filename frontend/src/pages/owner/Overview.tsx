import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/common';
import { api, formatPrice } from '../../services/api';
import type { ProductSummary } from '../../types';

type OverviewData = {
  total_products: number;
  published: number;
  drafts: number;
  archived: number;
  low_stock_products: number;
  out_of_stock_sizes: number;
  low_stock_threshold: number;
  recent: ProductSummary[];
};

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<OverviewData>('/api/owner/overview').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const tiles = [
    ['Products', data.total_products],
    ['Published', data.published],
    ['Drafts', data.drafts],
    [`Low stock (≤${data.low_stock_threshold})`, data.low_stock_products],
    ['Sold-out sizes', data.out_of_stock_sizes],
  ] as const;

  return (
    <>
      <header className="page-head">
        <h1>Overview</h1>
        <Link className="btn btn-primary" to="/owner/products/new">Add New T-shirt</Link>
      </header>
      <div className="tiles">
        {tiles.map(([label, value]) => (
          <div className="tile" key={label}>
            <span className="tile-value">{value}</span>
            <span className="tile-label">{label}</span>
          </div>
        ))}
      </div>
      <section className="card">
        <h2>Recently added</h2>
        {data.recent.length === 0 ? (
          <p className="muted">No products yet. <Link to="/owner/products/new">Add your first T-shirt.</Link></p>
        ) : (
          <ul className="recent">
            {data.recent.map((p) => (
              <li key={p.id}>
                <Link to={`/owner/products/${p.id}`}>
                  {p.thumb_url ? <img src={p.thumb_url} alt="" /> : <span className="thumb-empty" />}
                  <span className="recent-name">{p.name}</span>
                  <StatusBadge status={p.status} />
                  <span className="muted">{formatPrice(p.price, p.currency)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
