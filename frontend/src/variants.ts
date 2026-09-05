// Товары из Telegram приходят по одной строке на каждую реальную
// конфигурацию (память × связь × цвет), поэтому один и тот же телефон/планшет
// занимал в каталоге по 10-40 карточек. Здесь группируем такие строки в одну
// «модель» — карточка в каталоге показывает одну модель по цене самой
// дешёвой конфигурации, а выбор конкретной памяти/связи/цвета происходит на
// странице товара (см. product-page.ts, variantOptions()).
import type { Product } from "./types";

// Слова, по которым узнаём объём хранения — режем их из названия при
// вычислении ключа модели, иначе «256 GB» и «512 GB» станут разными моделями.
const STORAGE_RE = /\b\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб)?\b/gi;
const STORAGE_UNIT_RE = /\b\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб|mb|мб)\b/gi;

// Тип подключения — WiFi/5G/eSIM и т.п. — тоже не признак другой модели.
const CONN_RE =
  /\b(?:wi-?fi|5g|4g|lte|e-?sim|dual\s*sim|физическая\s*sim|актив(?:ирован)?|2\s*sim)\b/gi;

function stripModelNoise(name: string): string {
  return (" " + name + " ")
    .replace(STORAGE_RE, " ")
    .replace(STORAGE_UNIT_RE, " ")
    .replace(CONN_RE, " ")
    .replace(/[()]/g, " ")
    .replace(/[\/,+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Убирает из строки конкретное значение цвета (из поля color), если оно там
// встречается — то, что останется, это и есть «конфигурация» без цвета.
function stripColor(text: string, color: string | null | undefined): string {
  if (!color) return text;
  const parts = color.split(/[\/,]/).map((c) => c.trim()).filter(Boolean);
  let out = text;
  for (const part of [color, ...parts]) {
    if (!part) continue;
    const re = new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

// Ключ модели: бренд + категория + название без памяти/связи. Цвет НЕ режем
// здесь — если он входит в название как часть модели с постоянной ценой
// (напр. отдельные строки типа «Titanium Gray» без числового намёка на
// характеристику), это не страшно: такие товары просто останутся отдельными
// карточками, что безопаснее, чем ошибочно слить разные по факту товары.
export function modelKey(p: Product): string {
  let stripped = stripModelNoise(String(p.name || "")).toLowerCase();
  // Бренд иногда входит в название («Apple iPad…»), иногда нет («iPad…») —
  // приводим к одному виду, иначе одна и та же модель заводит две карточки.
  const brand = String(p.brand || "").toLowerCase().trim();
  if (brand && stripped.startsWith(brand)) {
    stripped = stripped.slice(brand.length).trim();
  }
  // Категория из Telegram тоже не всегда одинаковая для одной и той же модели
  // («iPad» vs «Планшеты») — в ключ модели её не берём, названия достаточно.
  return `${brand}|${stripped}`;
}

// «Конфигурация» товара для пилюль на странице товара — то, что осталось от
// названия после вычитания базовой модели и цвета: обычно память + связь.
export function configLabel(p: Product, baseName: string): string {
  let rest = String(p.name || "");
  const baseLower = baseName.toLowerCase();
  const idx = rest.toLowerCase().indexOf(baseLower);
  if (baseLower && idx !== -1) rest = rest.slice(0, idx) + rest.slice(idx + baseName.length);
  rest = stripColor(rest, p.color);
  rest = rest.replace(/[()]/g, " ").replace(/^[\s/,+-]+|[\s/,+-]+$/g, "").replace(/\s+/g, " ").trim();
  return rest;
}

export interface ModelGroup {
  key: string;
  name: string;
  products: Product[];
  cheapest: Product;
}

// Группирует каталог по модели. name/cheapest берутся по самому короткому
// названию с наименьшей ценой — обычно это и есть «голое» имя модели.
export function groupByModel(products: Product[]): ModelGroup[] {
  const map = new Map<string, Product[]>();
  for (const p of products) {
    const k = modelKey(p);
    const list = map.get(k);
    if (list) list.push(p);
    else map.set(k, [p]);
  }
  const groups: ModelGroup[] = [];
  for (const [key, list] of map) {
    const cheapest = list.reduce((min, p) => (p.price < min.price ? p : min), list[0]);
    const shortest = list.reduce((s, p) => (p.name.length < s.length ? p.name : s), list[0].name);
    groups.push({ key, name: shortest, products: list, cheapest });
  }
  return groups;
}

// Для страницы товара: все конфигурации внутри группы текущего товара,
// с точной ценой и слагом каждой (без формул-приближений).
export function variantsFor(p: Product, all: Product[]): { baseName: string; options: { label: string; product: Product }[] } {
  const key = modelKey(p);
  const siblings = all.filter((x) => modelKey(x) === key);
  const baseName = siblings.reduce((s, x) => (x.name.length < s.length ? x.name : s), siblings[0]?.name || p.name);
  const seen = new Set<string>();
  const options: { label: string; product: Product }[] = [];
  for (const sib of siblings.sort((a, b) => a.price - b.price)) {
    const label = configLabel(sib, baseName) || sib.color || sib.name;
    const dedupeKey = `${label}__${sib.color || ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    options.push({ label, product: sib });
  }
  return { baseName, options };
}
