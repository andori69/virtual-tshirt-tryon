import type { ProductStatus } from '../types';

export function StatusBadge({ status }: { status: ProductStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function Problems({ title, items }: { title?: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="problems" role="alert">
      {title && <strong>{title}</strong>}
      <ul>{items.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}
