export const SIZE_LABELS = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type SizeLabel = (typeof SIZE_LABELS)[number];

export type Point = { x: number; y: number };
export const ANCHOR_KEYS = [
  'left_shoulder', 'right_shoulder', 'neckline_center', 'left_sleeve', 'right_sleeve',
  'left_hem', 'right_hem', 'bottom_center',
] as const;
export type AnchorKey = (typeof ANCHOR_KEYS)[number];
export type Anchors = Record<AnchorKey, Point>;

export type SizeChartRow = {
  id?: number;
  label: SizeLabel;
  chest_width_cm: number;
  shoulder_width_cm: number;
  length_cm: number;
  sleeve_length_cm: number;
  sleeve_opening_cm: number | null;
};

export type CatalogVariant = {
  id: number;
  color_name: string;
  color_hex: string;
  garment_url: string;
  thumb_url: string;
  anchors: Anchors;
  sizes: { label: SizeLabel; available: boolean; low_stock: boolean }[];
};

export type CatalogProduct = {
  id: number;
  name: string;
  brand: string;
  description: string;
  price: string;
  currency: string;
  is_sample: boolean;
  size_chart: SizeChartRow[];
  variants: CatalogVariant[];
};

export type ShirtAttributes = {
  base_color_hex?: string;
  base_color_name?: string;
  print?: { has_print: boolean; coverage: number; color_name?: string };
  sleeve_length?: 'short' | 'long' | 'sleeveless';
  neckline?: string;
};

/** A shirt image from the ./Tshirts folder. */
export type WardrobeItem = {
  id: string;
  file: string;
  label: string;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  garment_url: string | null;
  thumb_url: string | null;
  back_url: string | null;          // back view, when the photo showed front above back
  mesh_url: string | null;          // shirt mesh built from the photo (null: procedural shirt)
  anchors: Anchors | null;
  attributes: ShirtAttributes | null;
};

export type KioskConfig = {
  camera: { width: number; height: number; frame_rate: number };
  idle_reset_s: number;
  shoulder_landmark_factor: number;
  calibration: { px_per_cm: number; frame_width: number; frame_height: number } | null;
};

export type FitCategory = 'tight' | 'regular' | 'relaxed' | 'oversized';
export type Recommendation =
  | {
      status: 'ok';
      recommended: SizeLabel;
      recommended_available: SizeLabel | null;
      confidence: number;
      confidence_label: 'high' | 'medium' | 'low';
      explanation: string;
      body_estimate: Record<string, number | null>;
      sizes: { label: SizeLabel; fit: FitCategory; chest_ease_cm: number | null; shoulder_diff_cm: number; in_stock: boolean }[];
      notes: string[];
    }
  | { status: 'insufficient'; reason: string; confidence?: number; notes?: string[] };

export type GarmentImage = {
  id: number;
  view: string;
  status: 'uploaded' | 'processed' | 'failed';
  error: string | null;
  original_url: string;
  processed_url: string | null;
  thumb_url: string | null;
  anchors: Anchors | null;
  anchors_auto: Anchors | null;
  anchors_confirmed: boolean;
  meta: { warnings?: string[]; processing_ms?: number; dominant_color?: string; coverage?: number } | null;
  updated_at: string;
};

export type OwnerVariant = {
  id: number;
  color_name: string;
  color_hex: string;
  ready: boolean;
  image: GarmentImage | null;
  stock: Partial<Record<SizeLabel, number>>;
};

export type ProductStatus = 'draft' | 'published' | 'archived';

export type ProductSummary = {
  id: number;
  name: string;
  brand: string;
  price: string | null;
  currency: string;
  status: ProductStatus;
  is_sample: boolean;
  thumb_url: string | null;
  colors: string[];
  sizes: SizeLabel[];
  total_stock: number;
  created_at: string;
  updated_at: string;
};

export type ProductDetail = Omit<ProductSummary, 'sizes'> & {
  description: string;
  sizes: SizeChartRow[];
  variants: OwnerVariant[];
  publish_ready: boolean;
  publish_problems: string[];
};
