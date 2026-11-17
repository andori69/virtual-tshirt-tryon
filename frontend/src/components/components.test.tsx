import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { validateSizeDraft } from '../pages/owner/ProductEditor';
import { parseError } from '../services/api';
import { precheckFile } from './ImageInput';
import { FitPanel, SizePicker } from './kiosk';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SizePicker', () => {
  it('disables sold-out sizes and marks the suggestion', async () => {
    const onSelect = vi.fn();
    render(
      <SizePicker
        sizes={[{ label: 'S', available: true, low_stock: false }, { label: 'M', available: false, low_stock: false },
          { label: 'L', available: true, low_stock: true }]}
        selected="S" recommended="L" onSelect={onSelect}
      />,
    );
    const m = screen.getByRole('radio', { name: /M/ });
    expect(m).toBeDisabled();
    await userEvent.click(m);
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: /L/ }));
    expect(onSelect).toHaveBeenCalledWith('L');
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('Few left')).toBeInTheDocument();
  });
});

describe('FitPanel', () => {
  it('shows why no size can be recommended', () => {
    render(<FitPanel size={null} rec={{ status: 'insufficient', reason: 'The camera has not been calibrated.' }} waiting />);
    expect(screen.getByText(/not been calibrated/)).toBeInTheDocument();
  });
  it('shows recommendation, fit category and confidence', () => {
    render(
      <FitPanel
        size={{ label: 'M', chest_width_cm: 51, shoulder_width_cm: 44, length_cm: 69, sleeve_length_cm: 20, sleeve_opening_cm: null }}
        rec={{
          status: 'ok', recommended: 'L', recommended_available: 'L', confidence: 0.62, confidence_label: 'medium',
          explanation: 'Size L gives the closest to a regular fit.', body_estimate: {}, notes: ['estimate'],
          sizes: [{ label: 'M', fit: 'tight', chest_ease_cm: 2, shoulder_diff_cm: 0, in_stock: true }],
        }}
        waiting={false}
      />,
    );
    expect(screen.getByText('Tight')).toBeInTheDocument();
    expect(screen.getByText(/confidence: medium \(62%\)/)).toBeInTheDocument();
    expect(screen.getByText('51 cm')).toBeInTheDocument();
  });
});

describe('validation helpers', () => {
  it('validates the size table', () => {
    const blank = { on: false, chest: '', shoulder: '', length: '', sleeve: '', opening: '' };
    const d = { XS: blank, S: { ...blank, on: true, chest: '48', shoulder: '42', length: '66', sleeve: '19' },
      M: { ...blank, on: true, chest: '-1', shoulder: '44', length: '', sleeve: '20' }, L: blank, XL: blank, XXL: blank };
    const r = validateSizeDraft(d);
    expect(r.problems).toEqual(['M: chest width must be a positive number.', 'M: length must be a positive number.']);
    expect(r.rows[0]).toMatchObject({ label: 'S', chest_width_cm: 48, sleeve_opening_cm: null });
    const none = validateSizeDraft({ XS: blank, S: blank, M: blank, L: blank, XL: blank, XXL: blank });
    expect(none.problems).toContain('Turn on at least one size.');
  });
  it('prechecks uploads', () => {
    expect(precheckFile(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/PNG, JPG or WEBP/);
    expect(precheckFile(new File([], 'a.png', { type: 'image/png' }))).toMatch(/empty/);
    expect(precheckFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull();
  });
  it('parses API error shapes', async () => {
    expect((await parseError(json({ detail: 'Nope' }, 401))).message).toBe('Nope');
    const e = await parseError(json({ detail: { message: 'Not ready', problems: ['a', 'b'] } }, 422));
    expect(e.problems).toEqual(['a', 'b']);
    const v = await parseError(json({ detail: [{ loc: ['body', 'name'], msg: 'too short' }] }, 422));
    expect(v.problems).toEqual(['name: too short']);
    expect((await parseError(new Response('oops', { status: 500 }))).message).toMatch(/server had a problem/);
  });
});

describe('owner auth', () => {
  it('redirects to login when not signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Sign in required.' }, 401)));
    render(<MemoryRouter initialEntries={['/owner/products']}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Owner sign in' })).toBeInTheDocument();
  });

  it('shows login errors and enters the dashboard on success', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/login') {
        const body = JSON.parse(String(init?.body));
        return body.password === 'right-password' ? json({ username: 'owner' }) : json({ detail: 'Incorrect username or password.' }, 401);
      }
      if (url === '/api/auth/me') return json({ username: 'owner' });
      if (url === '/api/owner/overview') {
        return json({ total_products: 3, published: 1, drafts: 2, archived: 0, low_stock_products: 1, out_of_stock_sizes: 4, low_stock_threshold: 3, recent: [] });
      }
      return json({ detail: 'not mocked' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/owner/login']}><AppRoutes /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Username'), 'owner');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.');

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'right-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Sold-out sizes').previousSibling).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });
});
