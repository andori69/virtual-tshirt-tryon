import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/common';
import { api } from '../../services/api';
import type { ProductStatus } from '../../types';

type Row = {
  product_id: number; product_name: string; status: ProductStatus; variant_id: number;
  color_name: string; size: string; quantity: number; state: 'ok' | 'low' | 'out';
};

export default function Inventory() {
  const [data, setData] = useState<{ low_stock_threshold: number; rows: Row[] } | null>(null);
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ low_stock_threshold: number; rows: Row[] }>('/api/owner/inventory').then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const save = async (r: Row, qty: number) => {
    const key = `${r.variant_id}-${r.size}`;
    if (!Number.isInteger(qty) || qty < 0) return setError('Quantity must be a whole number ≥ 0.');
    setSavingKey(key);
    setError(null);
    try {
      await api(`/api/owner/variants/${r.variant_id}/stock`, { method: 'PUT', json: { quantities: { [r.size]: qty } } });
      setEdits(({ [key]: _, ...rest }) => rest);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const rows = data.rows.filter((r) => filter === 'all' || r.state === filter);

  return (
    <>
      <header className="page-head"><h1>Inventory</h1></header>
      <div className="tabs" role="tablist">
        {(['all', 'low', 'out'] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'low' ? `Low stock (≤${data.low_stock_threshold})` : 'Sold out'}
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {rows.length === 0 ? <p className="muted card">Nothing to show.</p> : (
        <table className="table">
          <thead><tr><th>Product</th><th>Status</th><th>Color</th><th>Size</th><th>Quantity</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.variant_id}-${r.size}`;
              const value = edits[key] ?? String(r.quantity);
              return (
                <tr key={key} className={`stock-${r.state}`}>
                  <td><Link to={`/owner/products/${r.product_id}`}>{r.product_name}</Link></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.color_name}</td>
                  <td>{r.size}</td>
                  <td>
                    <input type="number" min="0" step="1" value={value} aria-label={`${r.product_name} ${r.color_name} ${r.size} quantity`}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })} className="qty" />
                    {r.state !== 'ok' && <span className={`badge badge-${r.state}`}>{r.state === 'out' ? 'sold out' : 'low'}</span>}
                  </td>
                  <td className="row">
                    {edits[key] !== undefined && <button className="btn" disabled={savingKey === key} onClick={() => save(r, Number(value))}>Save</button>}
                    {r.quantity > 0 && <button className="btn btn-ghost" disabled={savingKey === key} onClick={() => save(r, 0)}>Mark sold out</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">To hide a product from customers entirely, unpublish or archive it from its product page.</p>
    </>
  );
}
