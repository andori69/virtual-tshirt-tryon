import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageUpdate } from '../../components/FittingStage';
import Kiosk from './Kiosk';

// TEST DOUBLE: the real stage needs a webcam and MediaPipe. This stub only records props and lets the test
// push tracking updates; it is never used outside tests.
const stage = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('../../components/FittingStage', () => ({
  default: (p: Record<string, unknown>) => {
    stage.props = p;
    return <div data-testid="stage" />;
  },
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const anchors = {
  left_shoulder: { x: 0.3, y: 0.1 }, right_shoulder: { x: 0.7, y: 0.1 }, neckline_center: { x: 0.5, y: 0.12 },
  left_sleeve: { x: 0.1, y: 0.25 }, right_sleeve: { x: 0.9, y: 0.25 }, left_hem: { x: 0.28, y: 0.9 },
  right_hem: { x: 0.72, y: 0.9 }, bottom_center: { x: 0.5, y: 0.9 },
};
const catalog = [{
  id: 7, name: 'Crew Tee', brand: 'B', description: '', price: '499.00', currency: 'PHP', is_sample: false,
  size_chart: [
    { label: 'S', chest_width_cm: 48, shoulder_width_cm: 42, length_cm: 66, sleeve_length_cm: 19, sleeve_opening_cm: null },
    { label: 'M', chest_width_cm: 51, shoulder_width_cm: 44, length_cm: 69, sleeve_length_cm: 20, sleeve_opening_cm: null },
    { label: 'L', chest_width_cm: 54, shoulder_width_cm: 46, length_cm: 72, sleeve_length_cm: 21, sleeve_opening_cm: null },
  ],
  variants: [{
    id: 70, color_name: 'Navy', color_hex: '#22304f', garment_url: '/assets/processed/a.png', thumb_url: '/assets/thumbs/a.png', anchors,
    sizes: [{ label: 'S', available: false, low_stock: false }, { label: 'M', available: true, low_stock: false }, { label: 'L', available: true, low_stock: false }],
  }],
}];
const config = { camera: { width: 1280, height: 720, frame_rate: 30 }, idle_reset_s: 60, shoulder_landmark_factor: 1.15,
  calibration: { px_per_cm: 5, frame_width: 1280, frame_height: 720 } };

afterEach(() => vi.unstubAllGlobals());

function push(u: Partial<StageUpdate>) {
  act(() => (stage.props!.onUpdate as (x: StageUpdate) => void)({
    tracking: 'tracking', body: null, frame: { width: 1280, height: 720 }, fps: 30, latencyMs: 10, delegate: 'GPU', inFrame: true, ...u,
  }));
}

describe('Kiosk', () => {
  it('lists published products, blocks sold-out sizes, recommends and resets the session', async () => {
    const recommend = vi.fn(async (_url: string, _init?: RequestInit) => json({
      status: 'ok', recommended: 'L', recommended_available: 'L', confidence: 0.8, confidence_label: 'high',
      explanation: 'Size L gives the closest to a regular fit.', body_estimate: {}, notes: [],
      sizes: [{ label: 'M', fit: 'tight', chest_ease_cm: 2, shoulder_diff_cm: 0, in_stock: true },
        { label: 'L', fit: 'regular', chest_ease_cm: 8, shoulder_diff_cm: 1, in_stock: true }],
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/kiosk/config') return json(config);
      if (url === '/api/catalog') return json(catalog);
      if (url === '/api/wardrobe') return json([]);
      if (url === '/api/fitting/recommend') return recommend(url, init);
      throw new Error(url);
    }));

    render(<Kiosk />);
    await userEvent.click(await screen.findByRole('button', { name: /Crew Tee/ }));

    const sizes = screen.getByRole('radiogroup', { name: 'Size' });
    expect(within(sizes).getByRole('radio', { name: /S/ })).toBeDisabled();
    expect(within(sizes).getByRole('radio', { name: /^M/ })).toHaveAttribute('aria-checked', 'true'); // first available
    expect(stage.props!.garment).toMatchObject({ url: '/assets/processed/a.png' });
    expect((stage.props!.size as { label: string }).label).toBe('M');

    push({ body: { shoulder_span_px: 200, chest_width_px: 210, torso_length_px: 300, visibility: 0.9, stability_cv: 0.01, samples: 30 } });
    expect(await screen.findByText(/closest to a regular fit/)).toBeInTheDocument();
    const sent = JSON.parse(String(recommend.mock.calls[0][1]!.body));
    expect(sent).toMatchObject({ product_id: 7, variant_id: 70, body: { frame_width: 1280, samples: 30 } });
    expect(within(sizes).getByText('Suggested')).toBeInTheDocument();

    await userEvent.click(within(sizes).getByRole('radio', { name: /L/ }));
    expect((stage.props!.size as { label: string }).label).toBe('L');

    const keyBefore = stage.props!.sessionKey as number;
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.queryByRole('radiogroup', { name: 'Size' })).not.toBeInTheDocument();
    expect(screen.queryByText(/closest to a regular fit/)).not.toBeInTheDocument();
    expect(stage.props!.sessionKey).toBe(keyBefore + 1); // body samples in the stage are discarded
    expect(stage.props!.garment).toBeNull();
  });

  it('shows the welcome prompt when nobody is in view', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/catalog' || url === '/api/wardrobe' ? [] : config)));
    render(<Kiosk />);
    await screen.findByTestId('stage');
    push({ tracking: 'no-person' });
    expect(screen.getByRole('heading', { name: 'Try on a T-shirt' })).toBeInTheDocument();
    expect(screen.getByText(/No shirt images found/)).toBeInTheDocument();
  });

  it('tries on a shirt from the folder, fitted to the body, and resets', async () => {
    const shirts = [
      { id: 'a1', file: 'good_things-tee.jpg', label: 'Good Things Tee', status: 'ready', error: null,
        garment_url: '/api/wardrobe/a1/garment.png', thumb_url: '/api/wardrobe/a1/thumb.png', back_url: '/api/wardrobe/a1/back.png', anchors,
        attributes: { base_color_name: 'black', base_color_hex: '#0b0b0b', sleeve_length: 'short', neckline: 'high crew',
          print: { has_print: true, coverage: 0.29, color_name: 'white' } } },
      { id: 'b2', file: 'new.png', label: 'New', status: 'processing', error: null, garment_url: null, thumb_url: null, anchors: null, attributes: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/wardrobe' ? shirts : url === '/api/catalog' ? [] : config)));
    render(<Kiosk />);
    expect(await screen.findByRole('button', { name: /New/ })).toBeDisabled(); // still processing
    await userEvent.click(screen.getByRole('button', { name: /Good Things Tee/ }));
    expect(stage.props!.garment).toMatchObject({
      url: '/api/wardrobe/a1/garment.png', backUrl: '/api/wardrobe/a1/back.png', color: '#0b0b0b', sleeve: 'short',
    });
    expect(stage.props!.size).toBeNull(); // folder shirts are fitted to the body, not sized
    expect(stage.props!.style).toBe('regular');
    await userEvent.click(screen.getByRole('radio', { name: 'Oversized' }));
    expect(stage.props!.style).toBe('oversized');
    expect(screen.getByText('black')).toBeInTheDocument();
    expect(screen.getByText('white print')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(stage.props!.garment).toBeNull();
  });
});
