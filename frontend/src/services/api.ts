export class ApiError extends Error {
  constructor(message: string, public status: number, public problems: string[] = []) {
    super(message);
  }
}

export async function parseError(res: Response): Promise<ApiError> {
  let detail: unknown;
  try {
    detail = (await res.json()).detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === 'string') return new ApiError(detail, res.status);
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const d = detail as { message: string; problems?: string[] };
    return new ApiError(d.message, res.status, d.problems ?? []);
  }
  if (Array.isArray(detail)) {
    // FastAPI validation errors
    const problems = detail.map((e: { loc?: unknown[]; msg?: string }) =>
      `${(e.loc ?? []).filter((p) => p !== 'body').join('.')}: ${e.msg}`);
    return new ApiError('Some fields are invalid.', res.status, problems);
  }
  if (res.status >= 500) return new ApiError('The server had a problem. Please try again.', res.status);
  return new ApiError(`Request failed (${res.status}).`, res.status);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      headers: json !== undefined ? { 'Content-Type': 'application/json', ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check that the backend is running.', 0);
  }
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

export function upload<T>(path: string, fields: Record<string, string | Blob>, filename = 'image.jpg'): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) form.append(k, v, v instanceof File ? v.name : filename);
    else form.append(k, v);
  }
  return api<T>(path, { method: 'POST', body: form });
}

export function formatPrice(price: string | null, currency: string): string {
  if (price == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(price));
  } catch {
    return `${currency} ${price}`;
  }
}
