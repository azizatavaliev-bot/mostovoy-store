// Контакты магазина для кнопок-заявок (Купить / Доставка).
// wa — номер WhatsApp в межд. формате без + (напр. 996700123456). tg — username Telegram.
//
// Сами данные лежат в data/phones.json — это тот же файл, что читает
// server/services/seed.js для первичного наполнения каталога (JSON, а не
// TS/браузерный скрипт, чтобы backend читал его напрямую через JSON.parse).
import type { Swatch } from "./types";
import phonesData from "./data/phones.json";

export const STORE = { name: "МОСТОВОЙ", wa: "", tg: "mostovoyshop" };

export interface Phone {
  id: string;
  brand: string;
  style: "apple" | "samsung";
  name: string;
  gen: string;
  badge: string;
  price: number;
  tone: string;
  lenses: number;
  display: string;
  chip: string;
  camera: string;
  battery: string;
  material: string;
  storage: string;
  os: string;
  weight: string;
  connector: string;
  water: string;
  front: string;
  colors: string;
  swatches?: Swatch[];
  desc: string;
  img?: string;
}

// Каталог. ТТХ — фактические. Цены — примерные (демо), замени на свои.
// brand: Apple | Samsung · style: apple | samsung (для рендера камеры)
// tone — цвет корпуса; lenses — число камер; swatches — доступные цвета.
export const PHONES: Phone[] = phonesData as Phone[];

export function getPhone(id: string): Phone | undefined {
  return PHONES.find((p) => p.id === id);
}
