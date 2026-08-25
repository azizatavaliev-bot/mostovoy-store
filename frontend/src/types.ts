// Общие типы витрины. Товар из /api/catalog отдаёт больше полей, чем мы
// используем на фронте, поэтому индекс-сигнатура держит остальное как unknown
// без переусложнения — полную схему API типизировать здесь не требуется.

export type Swatch = [name: string, hex: string];

export interface Specifications {
  [label: string]: string | undefined;
}

export interface Product {
  id: string;
  name: string;
  brand?: string;
  category?: string;
  group?: string;
  price: number;
  currency: string;
  available: boolean;
  image?: string | null;
  img?: string | null;
  images?: string[];
  description?: string;
  specifications?: Specifications;
  storage?: string | null;
  color?: string | null;
  variant?: string | null;
  badge?: string;
  needsResearch?: boolean;
  discountPercent?: number | null;
  discountLabel?: string | null;
  salePrice?: number | null;
  // Поля для SVG-рендера телефона (только у товаров из data.js).
  // forceSvg: явная просьба показать векторный рендер вместо фото (выбран
  // цвет, для которого нет отдельного фото) — не путать с image=null,
  // означающим просто "фото ещё не загружено в базу".
  forceSvg?: boolean;
  tone?: string;
  lenses?: number;
  style?: string;
  swatches?: Swatch[];
  display?: string;
  chip?: string;
  gen?: string;
  sourcePage?: string;
  [key: string]: unknown;
}

export interface Contact {
  whatsapp: string;
  telegram: string;
  url: string;
  channel: string;
  channelUrl: string;
}

export interface Rates {
  base: string;
  [currency: string]: number | string | undefined;
}

export interface CartEntry {
  qty: number;
  color: string | null;
}

export type Cart = Record<string, CartEntry>;

export interface CartItem {
  product: Product;
  qty: number;
  color: string | null;
}

export interface Installment {
  monthly: number;
  total: number;
  overpay: number;
  rate: number | null;
}
