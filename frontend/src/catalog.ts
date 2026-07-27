// Общий слой витрины: живой каталог из API, валюта отображения и корзина.
// Импортируется из main.ts / product-page.ts.
//
// Каталог берётся из /api/catalog (данные из Telegram). Если бэкенд недоступен
// (например, сайт открыт как статика), используется PHONES из data.js —
// витрина продолжает работать.
import { PHONES, type Phone } from "./data";
import { PHOTOS } from "./photos";
import type { Cart, CartItem, Contact, Product, Rates } from "./types";

// --- Валюта отображения ---------------------------------------------------
// Цена товара хранится в базе как есть (из Telegram) и не пересчитывается.
// Здесь только показ: пользователь выбирает, в чём смотреть.

export type CurrencyCode = "USD" | "KGS" | "RUB";

export const CURRENCIES: Record<CurrencyCode, { code: CurrencyCode; label: string; suffix: string; decimals: number }> = {
  USD: { code: "USD", label: "$ USD", suffix: "$", decimals: 0 },
  KGS: { code: "KGS", label: "с KGS", suffix: "с", decimals: 0 },
  RUB: { code: "RUB", label: "₽ RUB", suffix: "₽", decimals: 0 },
};

export const CATALOG: { products: Product[]; contact: Contact; rates: Rates; live: boolean } = {
  products: [],
  contact: {
    // Заказ — в WhatsApp (он умеет предзаполнять текст), вопросы — в Telegram.
    whatsapp: "996999110110",
    telegram: "mostovoyshop",
    url: "https://t.me/mostovoyshop",
    channel: "mostovoyshopp",
    channelUrl: "https://t.me/mostovoyshopp",
  },
  // Сколько единиц валюты в одном долларе. Перекрывается значениями с сервера.
  rates: { base: "USD", USD: 1, KGS: 87.5, RUB: 79 },
  live: false,
};

const STORE_KEYS = { currency: "mostovoy_currency", cart: "mostovoy_cart" };

export function getDisplayCurrency(): CurrencyCode {
  const saved = localStorage.getItem(STORE_KEYS.currency) as CurrencyCode | null;
  return saved && CURRENCIES[saved] ? saved : "USD";
}

export function setDisplayCurrency(code: string): void {
  if (!CURRENCIES[code as CurrencyCode]) return;
  localStorage.setItem(STORE_KEYS.currency, code);
  document.dispatchEvent(new CustomEvent("currency:change", { detail: { code } }));
}

// Пересчёт через доллар — только для отображения.
export function convertPrice(amount: number | null | undefined, from: string, to: string): number | null {
  if (amount == null) return null;
  const rates = CATALOG.rates;
  const src = Number(rates[from]) || 1;
  const dst = Number(rates[to]) || 1;
  if (from === to) return amount;
  return (amount / src) * dst;
}

// Форматирование цены в выбранной валюте.
export function fmt(amount: number | null | undefined, sourceCurrency?: string | null): string {
  if (amount == null) return "—";
  const to = getDisplayCurrency();
  const from = sourceCurrency || "RUB";
  const value = convertPrice(amount, from, to);
  const cur = CURRENCIES[to];
  return Math.round(value as number).toLocaleString("ru-RU") + " " + cur.suffix;
}

// Цена в исходной валюте — для сообщений в Telegram (там нужна реальная цена).
export function fmtSource(amount: number | null | undefined, currency?: string | null): string {
  if (amount == null) return "—";
  const cur = CURRENCIES[currency as CurrencyCode] || { suffix: currency || "" };
  return Math.round(amount).toLocaleString("ru-RU") + " " + cur.suffix;
}

// --- Загрузка каталога ----------------------------------------------------

// Легаси-товары из data.js приводим к тому же виду, что и товары из API.
function fromLegacyPhones(): Product[] {
  return PHONES.map((p): Product => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: "Смартфоны",
    price: p.price,
    currency: "RUB",
    available: true,
    image: p.img || PHOTOS[p.id] || null,
    images: [],
    description: p.desc,
    specifications: {
      Дисплей: p.display, Процессор: p.chip, Камера: p.camera, Батарея: p.battery,
      Корпус: p.material, Защита: p.water, Разъём: p.connector, Память: p.storage,
      Вес: p.weight, ОС: p.os, Цвета: p.colors, "Фронтальная камера": p.front,
    },
    storage: null, color: null, variant: null,
    badge: p.badge || "",
    needsResearch: false,
    // Поля для SVG-рендера телефона.
    tone: p.tone, lenses: p.lenses, style: p.style, swatches: p.swatches,
    display: p.display, chip: p.chip, gen: p.gen,
  }));
}

interface CatalogResponse {
  products?: Product[];
  contact?: Partial<Contact>;
  rates?: Partial<Rates>;
}

export async function loadCatalog(): Promise<Product[]> {
  try {
    const res = await fetch("/api/catalog", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as CatalogResponse;
    if (Array.isArray(data.products) && data.products.length) {
      // Цена и наличие — из базы. Визуальные поля телефонов (цвет корпуса,
      // число камер, свотчи) берём из data.js по совпадению id: в базе их нет.
      const legacy = new Map<string, Phone>(PHONES.map((p) => [p.id, p]));
      CATALOG.products = data.products.map((p) => {
        const l = legacy.get(p.id);
        const visual = l ? { tone: l.tone, lenses: l.lenses, style: l.style, swatches: l.swatches } : {};
        return { ...p, ...visual, badge: p.needsResearch ? "" : p.badge || l?.badge || "" };
      });
      if (data.contact) CATALOG.contact = { ...CATALOG.contact, ...data.contact };
      if (data.rates) CATALOG.rates = { ...CATALOG.rates, ...data.rates };
      CATALOG.live = true;
      return CATALOG.products;
    }
  } catch (e) {
    console.warn("Каталог из API недоступен, показываем data.js:", (e as Error).message);
  }
  CATALOG.products = fromLegacyPhones();
  CATALOG.live = false;
  return CATALOG.products;
}

export function getProduct(id: string): Product | null {
  return CATALOG.products.find((p) => String(p.id) === String(id)) || null;
}

// --- Корзина --------------------------------------------------------------

// Позиция корзины: { qty, color }. Старый формат { id: число } поддерживаем.
function readCart(): Cart {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEYS.cart) || "{}") as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return {};
    const out: Cart = {};
    for (const [id, v] of Object.entries(raw)) {
      out[id] = typeof v === "number"
        ? { qty: v, color: null }
        : { qty: (v as { qty?: number }).qty || 1, color: (v as { color?: string | null }).color || null };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCart(cart: Cart): void {
  localStorage.setItem(STORE_KEYS.cart, JSON.stringify(cart));
  document.dispatchEvent(new CustomEvent("cart:change", { detail: { cart } }));
}

export function cartAdd(id: string, qty = 1, color: string | null = null): void {
  const cart = readCart();
  const item = cart[id] || { qty: 0, color: null };
  cart[id] = { qty: Math.max(1, item.qty + qty), color: color ?? item.color };
  writeCart(cart);
}

export function cartSet(id: string, qty: number): void {
  const cart = readCart();
  if (qty <= 0) delete cart[id];
  else cart[id] = { qty, color: cart[id]?.color ?? null };
  writeCart(cart);
}

export function cartRemove(id: string): void {
  cartSet(id, 0);
}

export function cartClear(): void {
  writeCart({});
}

export function cartCount(): number {
  return Object.values(readCart()).reduce((a, i) => a + i.qty, 0);
}

// Позиции корзины с раскрытыми товарами. Пропавшие товары отбрасываем.
export function cartItems(): CartItem[] {
  const cart = readCart();
  return Object.entries(cart)
    .map(([id, i]) => ({ product: getProduct(id), qty: i.qty, color: i.color }))
    .filter((i): i is CartItem => Boolean(i.product));
}

// Итог в валюте отображения (позиции могут быть в разных валютах).
export function cartTotal(): number {
  const to = getDisplayCurrency();
  return cartItems().reduce((sum, i) => sum + (convertPrice(i.product.price, i.product.currency, to) || 0) * i.qty, 0);
}

// --- Сообщения в Telegram -------------------------------------------------

// t.me/<username> не умеет предзаполнять текст, поэтому текст кладём
// в буфер обмена и открываем чат магазина.
export function telegramContactUrl(): string {
  return CATALOG.contact.url || `https://t.me/${CATALOG.contact.telegram}`;
}

export function productMessage(product: Product | null, selected: Partial<Pick<Product, "storage" | "color" | "variant">> = {}): string {
  if (!product) return "Здравствуйте! Хочу проконсультироваться по выбору техники.";
  const parts = [product.name];
  const inName = (v: unknown) => v && product.name.toLowerCase().includes(String(v).toLowerCase());
  const storage = selected.storage ?? product.storage;
  const color = selected.color ?? product.color;
  const variant = selected.variant ?? product.variant;
  if (storage && !inName(storage)) parts.push(`память ${storage}`);
  if (color && !inName(color)) parts.push(`цвет ${color}`);
  if (variant && !inName(variant)) parts.push(`вариант ${variant}`);

  let subject = parts.join(", ");
  if (product.price != null && product.currency) {
    subject += `${parts.length > 1 ? "," : ""} за ${Math.round(product.price)} ${product.currency}`;
  }
  return `Здравствуйте! Меня интересует ${subject}. Подскажите, товар сейчас в наличии?`;
}

// Заказ целиком: список позиций и итог.
export function cartMessage(): string {
  const items = cartItems();
  if (!items.length) return "Здравствуйте! Хочу проконсультироваться по выбору техники.";

  const lines = items.map((i, n) => {
    const price = `${Math.round(i.product.price)} ${i.product.currency}`;
    const color = i.color || i.product.color;
    return `${n + 1}. ${i.product.name}${color ? `, цвет ${color}` : ""} — ${price}${i.qty > 1 ? ` × ${i.qty}` : ""}`;
  });

  // Итог считаем отдельно по каждой валюте — конвертацию магазину не навязываем.
  const byCurrency: Record<string, number> = {};
  for (const i of items) {
    byCurrency[i.product.currency] = (byCurrency[i.product.currency] || 0) + i.product.price * i.qty;
  }
  const totals = Object.entries(byCurrency)
    .map(([cur, sum]) => `${Math.round(sum)} ${cur}`)
    .join(" + ");

  return `Здравствуйте! Хочу оформить заказ:\n${lines.join("\n")}\n\nИтого: ${totals}`;
}

// --- WhatsApp: сюда уходят заказы -----------------------------------------
// wa.me поддерживает ?text=, поэтому сообщение подставляется само.

export function whatsappUrl(text: string): string {
  const phone = String(CATALOG.contact.whatsapp || "").replace(/\D/g, "");
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function openWhatsApp(text: string): void {
  window.open(whatsappUrl(text), "_blank", "noopener");
}

// Копирует текст и открывает чат магазина. Возвращает true, если скопировалось.
export async function openTelegramWith(text: string): Promise<boolean> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }
  window.open(telegramContactUrl(), "_blank", "noopener");
  return copied;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("show"), 3200);
}

// «Купить» / «Оформить заказ» — WhatsApp с готовым текстом.
interface BuyClickItem {
  productId: string;
  quantity?: number;
}

function buyVisitorId(): string {
  const key = "mostovoy_analytics_visitor";
  let id = localStorage.getItem(key);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function trackBuyClick(items: BuyClickItem[], source: "product" | "cart"): void {
  if (!items.length) return;
  const body = JSON.stringify({
    items,
    source,
    pagePath: `${location.pathname}${location.search}`,
    visitorId: buyVisitorId(),
  });
  const blob = new Blob([body], { type: "application/json" });
  if (navigator.sendBeacon?.("/api/analytics/buy-click", blob)) return;
  fetch("/api/analytics/buy-click", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

export function handleOrderClick(text: string, items: BuyClickItem[], source: "product" | "cart"): void {
  trackBuyClick(items, source);
  openWhatsApp(text);
  toast("Открываем WhatsApp с вашим заказом");
}

// «Связаться» — Telegram. Текст кладём в буфер: t.me не умеет ?text=.
export async function handleTelegramClick(text: string): Promise<void> {
  const copied = await openTelegramWith(text);
  toast(copied ? "Сообщение скопировано — вставьте его в чат" : "Открываем чат магазина");
}

// --- Общий интерфейс: переключатель валюты и корзина -----------------------
// Создаётся из JS, чтобы обе страницы (главная и товар) получили его без
// дублирования разметки в index.html и product.html.

export function mountHeaderControls(): void {
  const header = document.querySelector(".header__inner");
  if (!header || header.querySelector(".curswitch")) return;

  const cta = header.querySelector(".header__cta");
  const burger = header.querySelector(".burger");

  const wrap = document.createElement("div");
  wrap.className = "headtools";

  const cur = document.createElement("div");
  cur.className = "curswitch";
  cur.innerHTML = Object.values(CURRENCIES)
    .map((c) => `<button type="button" data-cur="${c.code}" title="Показывать цены в ${c.code}">${c.suffix}</button>`)
    .join("");
  cur.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cur]");
    if (btn) setDisplayCurrency(btn.dataset.cur as string);
  });

  // Минималистичная иконка-сумка в стиле Feather Icons (MIT), встроена в код —
  // без внешних запросов и без зависимости от шрифта эмодзи.
  const CART_ICON = `<svg class="cartbtn__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <path d="M3 6h18"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>`;

  const cartBtn = document.createElement("button");
  cartBtn.type = "button";
  cartBtn.className = "cartbtn";
  cartBtn.setAttribute("aria-label", "Корзина");
  cartBtn.innerHTML = `${CART_ICON}<span class="cartbtn__n">0</span>`;
  cartBtn.addEventListener("click", () => openCart(true));

  wrap.appendChild(cur);
  wrap.appendChild(cartBtn);
  header.insertBefore(wrap, cta || burger || null);

  const syncCur = () => {
    const active = getDisplayCurrency();
    cur.querySelectorAll<HTMLElement>("[data-cur]").forEach((b) => b.classList.toggle("active", b.dataset.cur === active));
  };
  const syncCount = () => {
    const n = cartCount();
    cartBtn.querySelector(".cartbtn__n")!.textContent = String(n);
    cartBtn.classList.toggle("has", n > 0);
  };
  document.addEventListener("currency:change", syncCur);
  document.addEventListener("cart:change", syncCount);
  syncCur();
  syncCount();
}

// Плавающая кнопка WhatsApp — всегда видна справа, на любой странице.
export function mountWhatsappFloat(): void {
  if (document.querySelector(".wafloat")) return;

  const WA_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2c-5.52 0-10 4.48-10 10 0 1.77.46 3.45 1.27 4.9L2 22l5.25-1.38A9.96 9.96 0 0 0 12.04 22c5.52 0 10-4.48 10-10s-4.48-10-10-10zm5.87 14.2c-.25.7-1.45 1.34-2 1.43-.5.08-1.15.11-1.86-.12-.43-.14-.98-.32-1.69-.63-2.97-1.28-4.9-4.27-5.05-4.47-.15-.2-1.2-1.6-1.2-3.05 0-1.45.76-2.16 1.03-2.46.27-.3.6-.37.8-.37h.57c.18 0 .43-.07.67.51.25.6.85 2.08.92 2.23.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.32.4-.45.53-.15.15-.31.32-.13.63.18.3.79 1.3 1.7 2.1 1.17 1.04 2.15 1.37 2.46 1.52.31.15.49.13.67-.08.18-.2.77-.9.98-1.2.2-.31.4-.26.68-.16.27.1 1.75.82 2.05.97.3.15.5.23.57.35.08.13.08.73-.17 1.43z"/>
    </svg>`;

  const a = document.createElement("a");
  a.className = "wafloat";
  a.href = whatsappUrl("Здравствуйте! Хочу узнать про товар.");
  a.target = "_blank";
  a.rel = "noopener";
  a.setAttribute("aria-label", "Написать в WhatsApp");
  a.innerHTML = WA_ICON;

  document.body.appendChild(a);
}

export function mountCartDrawer(): void {
  if (document.querySelector(".cart")) return;

  const overlay = document.createElement("div");
  overlay.className = "cart__overlay";
  overlay.addEventListener("click", () => openCart(false));

  const drawer = document.createElement("aside");
  drawer.className = "cart";
  drawer.innerHTML = `
    <div class="cart__head">
      <h3>Корзина</h3>
      <button type="button" class="cart__close" aria-label="Закрыть">✕</button>
    </div>
    <div class="cart__body"></div>
    <div class="cart__foot">
      <div class="cart__total"><span>Итого</span><b></b></div>
      <button type="button" class="btn cart__buy">Купить в WhatsApp</button>
      <button type="button" class="cart__clear">Очистить корзину</button>
      <p class="cart__hint">Откроется WhatsApp с готовым списком заказа — останется только отправить.</p>
    </div>`;

  drawer.querySelector(".cart__close")!.addEventListener("click", () => openCart(false));
  drawer.querySelector(".cart__clear")!.addEventListener("click", () => cartClear());
  drawer.querySelector(".cart__buy")!.addEventListener("click", () => {
    const items = cartItems();
    if (!items.length) return toast("Корзина пуста");
    handleOrderClick(
      cartMessage(),
      items.map((item) => ({ productId: item.product.id, quantity: item.qty })),
      "cart"
    );
  });

  drawer.querySelector(".cart__body")!.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
    if (!id) return;
    if ((e.target as HTMLElement).closest(".ci__plus")) cartAdd(id, 1);
    if ((e.target as HTMLElement).closest(".ci__minus")) cartSet(id, (readCart()[id]?.qty || 1) - 1);
    if ((e.target as HTMLElement).closest(".ci__del")) cartRemove(id);
  });

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  document.addEventListener("cart:change", renderCart);
  document.addEventListener("currency:change", renderCart);
  renderCart();
}

export function openCart(show: boolean): void {
  document.querySelector(".cart")?.classList.toggle("open", show);
  document.querySelector(".cart__overlay")?.classList.toggle("show", show);
  document.body.classList.toggle("noscroll", show);
}

export function renderCart(): void {
  const body = document.querySelector(".cart__body");
  if (!body) return;
  const items = cartItems();

  body.innerHTML = items.length
    ? items
        .map(
          (i) => `<div class="ci" data-id="${i.product.id}">
            <div class="ci__name">
              <b>${i.product.name}</b>
              <span>${fmt(i.product.price, i.product.currency)}${i.color ? ` · ${i.color}` : ""}</span>
            </div>
            <div class="ci__qty">
              <button type="button" class="ci__minus" aria-label="Меньше">−</button>
              <span>${i.qty}</span>
              <button type="button" class="ci__plus" aria-label="Больше">+</button>
            </div>
            <button type="button" class="ci__del" aria-label="Удалить">✕</button>
          </div>`
        )
        .join("")
    : `<p class="cart__empty">Пока пусто. Добавьте товары из каталога.</p>`;

  const total = document.querySelector(".cart__total b");
  if (total) {
    const cur = CURRENCIES[getDisplayCurrency()];
    total.textContent = Math.round(cartTotal()).toLocaleString("ru-RU") + " " + cur.suffix;
  }
}

// Перерисовываем цены на странице при смене валюты.
export function onCurrencyChange(fn: () => void): void {
  document.addEventListener("currency:change", fn);
}
