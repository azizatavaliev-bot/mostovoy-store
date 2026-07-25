// Общий слой витрины: живой каталог из API, валюта отображения и корзина.
// Загружается после render.js и до script.js / product.js.
//
// Каталог берётся из /api/catalog (данные из Telegram). Если бэкенд недоступен
// (например, сайт открыт как статика), используется PHONES из data.js —
// витрина продолжает работать.

// --- Валюта отображения ---------------------------------------------------
// Цена товара хранится в базе как есть (из Telegram) и не пересчитывается.
// Здесь только показ: пользователь выбирает, в чём смотреть.

const CURRENCIES = {
  USD: { code: "USD", label: "$ USD", suffix: "$", decimals: 0 },
  KGS: { code: "KGS", label: "с KGS", suffix: "с", decimals: 0 },
  RUB: { code: "RUB", label: "₽ RUB", suffix: "₽", decimals: 0 },
};

const CATALOG = {
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

function getDisplayCurrency() {
  const saved = localStorage.getItem(STORE_KEYS.currency);
  return CURRENCIES[saved] ? saved : "USD";
}

function setDisplayCurrency(code) {
  if (!CURRENCIES[code]) return;
  localStorage.setItem(STORE_KEYS.currency, code);
  document.dispatchEvent(new CustomEvent("currency:change", { detail: { code } }));
}

// Пересчёт через доллар — только для отображения.
function convertPrice(amount, from, to) {
  if (amount == null) return null;
  const rates = CATALOG.rates;
  const src = rates[from] || 1;
  const dst = rates[to] || 1;
  if (from === to) return amount;
  return (amount / src) * dst;
}

// Форматирование цены в выбранной валюте.
function fmt(amount, sourceCurrency) {
  if (amount == null) return "—";
  const to = getDisplayCurrency();
  const from = sourceCurrency || "RUB";
  const value = convertPrice(amount, from, to);
  const cur = CURRENCIES[to];
  return Math.round(value).toLocaleString("ru-RU") + " " + cur.suffix;
}

// Цена в исходной валюте — для сообщений в Telegram (там нужна реальная цена).
function fmtSource(amount, currency) {
  if (amount == null) return "—";
  const cur = CURRENCIES[currency] || { suffix: currency || "" };
  return Math.round(amount).toLocaleString("ru-RU") + " " + cur.suffix;
}

// --- Загрузка каталога ----------------------------------------------------

// Легаси-товары из data.js приводим к тому же виду, что и товары из API.
function fromLegacyPhones() {
  if (typeof PHONES === "undefined") return [];
  return PHONES.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: "Смартфоны",
    price: p.price,
    currency: "RUB",
    available: true,
    image: p.img || (window.PHOTOS && window.PHOTOS[p.id]) || null,
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

async function loadCatalog() {
  try {
    const res = await fetch("/api/catalog", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (Array.isArray(data.products) && data.products.length) {
      // Цена и наличие — из базы. Визуальные поля телефонов (цвет корпуса,
      // число камер, свотчи) берём из data.js по совпадению id: в базе их нет.
      const legacy = new Map((typeof PHONES !== "undefined" ? PHONES : []).map((p) => [p.id, p]));
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
    console.warn("Каталог из API недоступен, показываем data.js:", e.message);
  }
  CATALOG.products = fromLegacyPhones();
  CATALOG.live = false;
  return CATALOG.products;
}

function getProduct(id) {
  return CATALOG.products.find((p) => String(p.id) === String(id)) || null;
}

// --- Корзина --------------------------------------------------------------

// Позиция корзины: { qty, color }. Старый формат { id: число } поддерживаем.
function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEYS.cart) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      out[id] = typeof v === "number" ? { qty: v, color: null } : { qty: v.qty || 1, color: v.color || null };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCart(cart) {
  localStorage.setItem(STORE_KEYS.cart, JSON.stringify(cart));
  document.dispatchEvent(new CustomEvent("cart:change", { detail: { cart } }));
}

function cartAdd(id, qty = 1, color = null) {
  const cart = readCart();
  const item = cart[id] || { qty: 0, color: null };
  cart[id] = { qty: Math.max(1, item.qty + qty), color: color ?? item.color };
  writeCart(cart);
}

function cartSet(id, qty) {
  const cart = readCart();
  if (qty <= 0) delete cart[id];
  else cart[id] = { qty, color: cart[id]?.color ?? null };
  writeCart(cart);
}

function cartRemove(id) {
  cartSet(id, 0);
}

function cartClear() {
  writeCart({});
}

function cartCount() {
  return Object.values(readCart()).reduce((a, i) => a + i.qty, 0);
}

// Позиции корзины с раскрытыми товарами. Пропавшие товары отбрасываем.
function cartItems() {
  const cart = readCart();
  return Object.entries(cart)
    .map(([id, i]) => ({ product: getProduct(id), qty: i.qty, color: i.color }))
    .filter((i) => i.product);
}

// Итог в валюте отображения (позиции могут быть в разных валютах).
function cartTotal() {
  const to = getDisplayCurrency();
  return cartItems().reduce((sum, i) => sum + convertPrice(i.product.price, i.product.currency, to) * i.qty, 0);
}

// --- Сообщения в Telegram -------------------------------------------------

// t.me/<username> не умеет предзаполнять текст, поэтому текст кладём
// в буфер обмена и открываем чат магазина.
function telegramContactUrl() {
  return CATALOG.contact.url || `https://t.me/${CATALOG.contact.telegram}`;
}

function productMessage(product, selected = {}) {
  if (!product) return "Здравствуйте! Хочу проконсультироваться по выбору техники.";
  const parts = [product.name];
  const inName = (v) => v && product.name.toLowerCase().includes(String(v).toLowerCase());
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
function cartMessage() {
  const items = cartItems();
  if (!items.length) return "Здравствуйте! Хочу проконсультироваться по выбору техники.";

  const lines = items.map((i, n) => {
    const price = `${Math.round(i.product.price)} ${i.product.currency}`;
    const color = i.color || i.product.color;
    return `${n + 1}. ${i.product.name}${color ? `, цвет ${color}` : ""} — ${price}${i.qty > 1 ? ` × ${i.qty}` : ""}`;
  });

  // Итог считаем отдельно по каждой валюте — конвертацию магазину не навязываем.
  const byCurrency = {};
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

function whatsappUrl(text) {
  const phone = String(CATALOG.contact.whatsapp || "").replace(/\D/g, "");
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

function openWhatsApp(text) {
  window.open(whatsappUrl(text), "_blank", "noopener");
}

// Копирует текст и открывает чат магазина. Возвращает true, если скопировалось.
async function openTelegramWith(text) {
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

function toast(message) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3200);
}

// «Купить» / «Оформить заказ» — WhatsApp с готовым текстом.
function handleOrderClick(text) {
  openWhatsApp(text);
  toast("Открываем WhatsApp с вашим заказом");
}

// «Связаться» — Telegram. Текст кладём в буфер: t.me не умеет ?text=.
async function handleTelegramClick(text) {
  const copied = await openTelegramWith(text);
  toast(copied ? "Сообщение скопировано — вставьте его в чат" : "Открываем чат магазина");
}

// --- Общий интерфейс: переключатель валюты и корзина -----------------------
// Создаётся из JS, чтобы обе страницы (главная и товар) получили его без
// дублирования разметки в index.html и product.html.

function mountHeaderControls() {
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
    const btn = e.target.closest("[data-cur]");
    if (btn) setDisplayCurrency(btn.dataset.cur);
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
    cur.querySelectorAll("[data-cur]").forEach((b) => b.classList.toggle("active", b.dataset.cur === active));
  };
  const syncCount = () => {
    const n = cartCount();
    cartBtn.querySelector(".cartbtn__n").textContent = String(n);
    cartBtn.classList.toggle("has", n > 0);
  };
  document.addEventListener("currency:change", syncCur);
  document.addEventListener("cart:change", syncCount);
  syncCur();
  syncCount();
}

function mountCartDrawer() {
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

  drawer.querySelector(".cart__close").addEventListener("click", () => openCart(false));
  drawer.querySelector(".cart__clear").addEventListener("click", () => cartClear());
  drawer.querySelector(".cart__buy").addEventListener("click", () => {
    if (!cartItems().length) return toast("Корзина пуста");
    handleOrderClick(cartMessage());
  });

  drawer.querySelector(".cart__body").addEventListener("click", (e) => {
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (!id) return;
    if (e.target.closest(".ci__plus")) cartAdd(id, 1);
    if (e.target.closest(".ci__minus")) cartSet(id, (readCart()[id] || 1) - 1);
    if (e.target.closest(".ci__del")) cartRemove(id);
  });

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  document.addEventListener("cart:change", renderCart);
  document.addEventListener("currency:change", renderCart);
  renderCart();
}

function openCart(show) {
  document.querySelector(".cart")?.classList.toggle("open", show);
  document.querySelector(".cart__overlay")?.classList.toggle("show", show);
  document.body.classList.toggle("noscroll", show);
}

function renderCart() {
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
function onCurrencyChange(fn) {
  document.addEventListener("currency:change", fn);
}
