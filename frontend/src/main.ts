// Логика главной: сайдбар-фильтр (тип товара → подкатегория, бренд, цена),
// поиск, сортировка, калькуляторы Zero-рассрочки и обмена, корзина, анимации.
// Данные берутся из CATALOG (живой каталог из Telegram) — см. catalog.ts.
import "./styles.css";
import {
  cartAdd,
  convertPrice,
  fmt,
  getDisplayCurrency,
  loadCatalog,
  mountCartDrawer,
  mountWhatsappFloat,
  onCurrencyChange,
  openCart,
  toast,
} from "./catalog";
import { enhanceSelects, installment, mediaHTML, refreshCustomSelect } from "./render";
import type { Product } from "./types";

interface FilterState {
  group: string | null;
  category: string | null;
  brands: Set<string>;
  q: string;
  sort: "pop" | "asc" | "desc";
  min: number | null;
  max: number | null;
}

const state: FilterState = { group: null, category: null, brands: new Set(), q: "", sort: "pop", min: null, max: null };

const grid = document.getElementById("grid") as HTMLDivElement;
const gridEmpty = document.getElementById("gridEmpty") as HTMLParagraphElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const sortSel = document.getElementById("sort") as HTMLSelectElement;
let products: Product[] = [];

// --- Сайдбар: тип товара → подкатегория, бренд, диапазон цены -------------

const groupsOf = () => [...new Set(products.map((p) => p.group).filter(Boolean))] as string[];

function categoriesOf(group: string | null): string[] {
  const src = group ? products.filter((p) => p.group === group) : products;
  return [...new Set(src.map((p) => p.category).filter(Boolean))].sort((a, b) => (a as string).localeCompare(b as string, "ru")) as string[];
}

function brandsOf(group: string | null, category: string | null): string[] {
  let src = products;
  if (group) src = src.filter((p) => p.group === group);
  if (category) src = src.filter((p) => p.category === category);
  return [...new Set(src.map((p) => p.brand).filter(Boolean))].sort((a, b) => (a as string).localeCompare(b as string, "ru")) as string[];
}

// Мин/макс цена по ВСЕМ товарам каталога (не по текущей выборке) — ориентир
// пользователю, в каких пределах вообще есть смысл фильтровать.
function priceBounds(): { min: number; max: number } {
  const cur = getDisplayCurrency();
  const prices = products.map((p) => convertPrice(p.price, p.currency, cur)).filter((v): v is number => Number.isFinite(v));
  if (!prices.length) return { min: 0, max: 0 };
  return { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)) };
}

const readLimit = (el: HTMLInputElement): number | null => {
  const v = Number.parseFloat(String(el.value).replace(/\s/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
};

function renderSidebar(): void {
  const bounds = priceBounds();
  const groups = groupsOf();
  const cats = categoriesOf(state.group);
  const brands = brandsOf(state.group, state.category);

  document.getElementById("sidebarBody")!.innerHTML = `
    <div class="catalog__filterGroup">
      <p class="catalog__filterTitle">Цена</p>
      <div class="pricefilter pricefilter--sidebar">
        <input type="number" id="priceMin" min="0" placeholder="от ${Math.round(bounds.min).toLocaleString("ru-RU")}" value="${state.min ?? ""}" />
        <span>—</span>
        <input type="number" id="priceMax" min="0" placeholder="до ${Math.round(bounds.max).toLocaleString("ru-RU")}" value="${state.max ?? ""}" />
      </div>
    </div>

    <div class="catalog__filterGroup">
      <p class="catalog__filterTitle">Тип товара</p>
      <div class="catalog__radios">
        <button type="button" class="catalog__radio ${!state.group ? "active" : ""}" data-group="">Все</button>
        ${groups.map((g) => `<button type="button" class="catalog__radio ${state.group === g ? "active" : ""}" data-group="${g}">${g}</button>`).join("")}
      </div>
      ${cats.length ? `<div class="catalog__subcats">${cats.map((c) => `<button type="button" class="chip ${state.category === c ? "active" : ""}" data-cat="${c}">${c}</button>`).join("")}</div>` : ""}
    </div>

    ${brands.length ? `
      <div class="catalog__filterGroup">
        <p class="catalog__filterTitle">Бренд</p>
        <div class="catalog__checks">
          ${brands.map((b) => `<label class="catalog__check"><input type="checkbox" data-brand="${b}" ${state.brands.has(b) ? "checked" : ""} /><span>${b}</span></label>`).join("")}
        </div>
      </div>` : ""}

    <button type="button" class="admin__link" id="btnClearFilters">Сбросить фильтры</button>`;

  wireSidebar();
}

function wireSidebar(): void {
  const body = document.getElementById("sidebarBody")!;

  body.querySelectorAll<HTMLButtonElement>("[data-group]").forEach((b) =>
    b.addEventListener("click", () => {
      state.group = b.dataset.group || null;
      state.category = null;
      state.brands = new Set();
      renderSidebar();
      renderGrid();
      renderActiveChips();
    })
  );

  body.querySelectorAll<HTMLButtonElement>("[data-cat]").forEach((b) =>
    b.addEventListener("click", () => {
      state.category = state.category === b.dataset.cat ? null : (b.dataset.cat as string);
      state.brands = new Set();
      renderSidebar();
      renderGrid();
      renderActiveChips();
    })
  );

  body.querySelectorAll<HTMLInputElement>("[data-brand]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) state.brands.add(cb.dataset.brand as string);
      else state.brands.delete(cb.dataset.brand as string);
      renderGrid();
      renderActiveChips();
    })
  );

  const min = document.getElementById("priceMin") as HTMLInputElement;
  const max = document.getElementById("priceMax") as HTMLInputElement;
  [min, max].forEach((el) =>
    el.addEventListener("input", () => {
      state.min = readLimit(min);
      state.max = readLimit(max);
      renderGrid();
      renderActiveChips();
    })
  );

  document.getElementById("btnClearFilters")!.addEventListener("click", clearFilters);
}

function clearFilters(): void {
  state.group = null;
  state.category = null;
  state.brands = new Set();
  state.min = null;
  state.max = null;
  renderSidebar();
  renderGrid();
  renderActiveChips();
}

interface Chip {
  label: string;
  clear: () => void;
}

// Плашки активных фильтров над сеткой — видно и снимается по одной, даже
// когда сайдбар на телефоне закрыт.
function renderActiveChips(): void {
  const chips: Chip[] = [];
  if (state.group) chips.push({ label: state.group, clear: () => { state.group = null; state.category = null; state.brands = new Set(); } });
  if (state.category) chips.push({ label: state.category, clear: () => { state.category = null; } });
  state.brands.forEach((b) => chips.push({ label: b, clear: () => state.brands.delete(b) }));
  if (state.min != null) chips.push({ label: `от ${state.min.toLocaleString("ru-RU")}`, clear: () => { state.min = null; } });
  if (state.max != null) chips.push({ label: `до ${state.max.toLocaleString("ru-RU")}`, clear: () => { state.max = null; } });

  const el = document.getElementById("activeChips")!;
  el.innerHTML = chips
    .map((c, i) => `<button type="button" class="catalog__activeChip" data-chip="${i}">${c.label} <span>✕</span></button>`)
    .join("");
  el.querySelectorAll<HTMLButtonElement>("[data-chip]").forEach((btn, i) =>
    btn.addEventListener("click", () => {
      chips[i].clear();
      renderSidebar();
      renderGrid();
      renderActiveChips();
    })
  );

  const count = chips.length;
  const badge = document.getElementById("filtersCount") as HTMLSpanElement;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

// Мобильный сайдбар — выезжающая панель, как корзина.
function openFilters(show: boolean): void {
  document.getElementById("sidebar")!.classList.toggle("open", show);
  document.getElementById("sidebarOverlay")!.classList.toggle("show", show);
  document.body.classList.toggle("noscroll", show);
}

// Границы цены вводятся в валюте отображения — сравниваем в ней же.
function inPriceRange(p: Product): boolean {
  if (state.min == null && state.max == null) return true;
  const shown = convertPrice(p.price, p.currency, getDisplayCurrency()) as number;
  if (state.min != null && shown < state.min) return false;
  if (state.max != null && shown > state.max) return false;
  return true;
}

function filtered(): Product[] {
  let list = products.slice();
  if (state.group) list = list.filter((p) => p.group === state.group);
  if (state.category) list = list.filter((p) => p.category === state.category);
  if (state.brands.size) list = list.filter((p) => p.brand != null && state.brands.has(p.brand));
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((p) => `${p.name} ${p.brand || ""} ${p.category || ""}`.toLowerCase().includes(q));
  }
  list = list.filter(inPriceRange);

  const shown = (p: Product) => convertPrice(p.price, p.currency, getDisplayCurrency()) as number;
  if (state.sort === "asc") list.sort((a, b) => shown(a) - shown(b));
  else if (state.sort === "desc") list.sort((a, b) => shown(b) - shown(a));
  else {
    // «По популярности»: Apple впереди, дальше — порядок каталога.
    const rank = (p: Product) => (p.brand === "Apple" ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || products.indexOf(a) - products.indexOf(b));
  }
  return list;
}

// Выбранный на карточке цвет: id товара → индекс свотча.
const cardColor = new Map<string, number>();

// Медиа карточки. Для выбранного НЕ первого цвета показываем векторный рендер
// в этом цвете: отдельных фото под каждый цвет у нас нет, а фото первого
// цвета вводило бы в заблуждение.
function cardMedia(p: Product): string {
  const idx = cardColor.get(p.id) || 0;
  if (!p.swatches?.length || idx === 0) return mediaHTML(p, "card__media");
  return mediaHTML({ ...p, tone: p.swatches[idx][1], image: null }, "card__media");
}

function swatchesHTML(p: Product): string {
  if (!p.swatches?.length) return "";
  const active = cardColor.get(p.id) || 0;
  return `<div class="card__sw">${p.swatches
    .map(
      (c, i) =>
        `<button type="button" class="csw ${i === active ? "active" : ""}" style="--c:${c[1]}"
           data-sw="${i}" data-for="${p.id}" title="${c[0]}" aria-label="Цвет: ${c[0]}"></button>`
    )
    .join("")}</div>`;
}

function cardHTML(p: Product): string {
  const hasDiscount = (p.discountPercent || 0) > 0 && p.salePrice != null && p.salePrice < p.price;
  const effectivePrice = hasDiscount ? (p.salePrice as number) : p.price;
  const monthly = installment(effectivePrice, 12).monthly;
  const colorName = p.swatches?.length ? p.swatches[cardColor.get(p.id) || 0][0] : p.color;
  const badge = hasDiscount
    ? `<span class="card__badge card__badge--sale">${p.discountLabel || `-${p.discountPercent}%`}</span>`
    : p.badge
    ? `<span class="card__badge">${p.badge}</span>`
    : `<span class="card__badge" style="visibility:hidden">·</span>`;
  return `<article class="card ${p.available ? "" : "card--out"}" data-card="${p.id}">
    <a class="card__link" href="product.html?id=${encodeURIComponent(p.id)}">
      ${badge}
      ${cardMedia(p)}
    </a>
    ${swatchesHTML(p)}
    <a class="card__link card__link--text" href="product.html?id=${encodeURIComponent(p.id)}">
      <h3 class="card__name">${p.name}</h3>
      <p class="card__spec">${colorName || p.category || ""}${p.available ? "" : " · нет в наличии"}</p>
      <div class="card__price">
        ${hasDiscount ? `<span class="card__old">${fmt(p.price, p.currency)}</span> ` : ""}${fmt(effectivePrice, p.currency)}
        <span class="card__from">/ от ${fmt(monthly, p.currency)} в мес.</span>
      </div>
    </a>
    <button type="button" class="card__add" data-add="${p.id}">В корзину</button>
  </article>`;
}

function renderGrid(): void {
  const list = filtered();
  gridEmpty.hidden = list.length > 0;
  grid.innerHTML = list.map(cardHTML).join("");
  observeCards();
}

// --- Акции: товары со скидкой, отдельным блоком на главной -----------------

function renderSales(): void {
  const section = document.getElementById("sales") as HTMLElement;
  const list = products
    .filter((p) => (p.discountPercent || 0) > 0 && p.salePrice != null && p.salePrice < p.price)
    .sort((a, b) => (b.discountPercent || 0) - (a.discountPercent || 0));
  section.hidden = list.length === 0;
  if (!list.length) return;
  document.getElementById("salesGrid")!.innerHTML = list.map(cardHTML).join("");
  observeCards();
}

// --- Поиск, сортировка, мобильный сайдбар ----------------------------------

searchInput.addEventListener("input", (e) => {
  state.q = (e.target as HTMLInputElement).value.trim();
  renderGrid();
});

sortSel.addEventListener("change", (e) => {
  state.sort = (e.target as HTMLSelectElement).value as FilterState["sort"];
  renderGrid();
});

document.getElementById("btnOpenFilters")!.addEventListener("click", () => openFilters(true));
document.getElementById("btnCloseFilters")!.addEventListener("click", () => openFilters(false));
document.getElementById("sidebarOverlay")!.addEventListener("click", () => openFilters(false));

grid.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  // Смена цвета прямо в каталоге — без перехода на страницу товара.
  const sw = target.closest<HTMLElement>("[data-sw]");
  if (sw) {
    e.preventDefault();
    const id = sw.dataset.for as string;
    cardColor.set(id, Number(sw.dataset.sw));
    const p = products.find((x) => String(x.id) === String(id));
    const card = grid.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (p && card) {
      // Перерисовываем только эту карточку, чтобы не дёргать весь список.
      card.querySelector(".card__media")!.outerHTML = cardMedia(p);
      card.querySelector(".card__sw")!.outerHTML = swatchesHTML(p);
      card.querySelector(".card__spec")!.textContent =
        (p.swatches as NonNullable<Product["swatches"]>)[cardColor.get(id) as number][0] + (p.available ? "" : " · нет в наличии");
    }
    return;
  }

  // Корзина: кнопка на карточке (карточка — ссылка, поэтому гасим переход).
  const add = target.closest<HTMLElement>("[data-add]");
  if (!add) return;
  e.preventDefault();
  const id = add.dataset.add as string;
  const p = products.find((x) => String(x.id) === String(id));
  const color = p?.swatches?.length ? p.swatches[cardColor.get(id) || 0][0] : null;
  cartAdd(id, 1, color);
  toast(color ? `Добавлено в корзину · ${color}` : "Добавлено в корзину");
});

// --- Почему мы лучшие ------------------------------------------------------

const WHY: [string, string, string][] = [
  ["🛡️", "Официальная гарантия", "1 год на всю технику"],
  ["✅", "Только оригинал", "Никаких копий и восстановленных под видом новых"],
  ["🔄", "Trade-in", "Обменяем ваш старый телефон с доплатой"],
  ["💳", "Рассрочка Zero", "Верификация в приложении — и техника ваша"],
  ["🚚", "Быстрая доставка", "По Бишкеку 1–2 дня, по всему Кыргызстану"],
  ["🛠️", "Свой сервис", "Настройка, перенос данных и ремонт на месте"],
  ["⭐", "50 000+ клиентов", "Нам доверяют по всей стране 12 лет"],
  ["🏆", "#1 в Кыргызстане", "Топ-продаж смартфонов и аксессуаров"],
];
const whyGrid = document.getElementById("whyGrid");
if (whyGrid) {
  whyGrid.innerHTML = WHY.map(
    (w) => `<div class="wcard reveal"><span class="wcard__ico">${w[0]}</span><b>${w[1]}</b><p>${w[2]}</p></div>`
  ).join("");
}

// --- Калькулятор обмена ----------------------------------------------------

const tradeModel = document.getElementById("tradeModel") as HTMLSelectElement;
const tradeState = document.getElementById("tradeState") as HTMLSelectElement;
const tradeResult = document.getElementById("tradeResult") as HTMLElement;

// Оценки трейд-ина заданы в долларах (см. index.html).
function calcTrade(): void {
  tradeResult.textContent = fmt(+tradeModel.value * +tradeState.value, "USD");
}
tradeModel.addEventListener("change", calcTrade);
tradeState.addEventListener("change", calcTrade);

// --- Калькулятор рассрочки Zero --------------------------------------------

const creditPrice = document.getElementById("creditPrice") as HTMLSelectElement;
const creditTerm = document.getElementById("creditTerm") as HTMLSelectElement;
const crMonthly = document.getElementById("crMonthly") as HTMLElement;
const crBreak = document.getElementById("crBreak") as HTMLElement;

function fillCreditModels(): void {
  const keep = creditPrice.selectedIndex;
  creditPrice.innerHTML = products
    .map((p) => `<option value="${p.price}" data-cur="${p.currency}">${p.name} — ${fmt(p.price, p.currency)}</option>`)
    .join("");
  if (keep >= 0 && keep < creditPrice.options.length) creditPrice.selectedIndex = keep;
  refreshCustomSelect(creditPrice);
}

function calcCredit(): void {
  const opt = creditPrice.options[creditPrice.selectedIndex];
  const cur = opt?.dataset.cur || "USD";
  const price = +creditPrice.value;
  const months = +creditTerm.value;
  const r = installment(price, months);

  crMonthly.textContent = fmt(r.monthly, cur);
  crBreak.innerHTML = `
    <div><span>Стоимость</span><b>${fmt(price, cur)}</b></div>
    <div><span>Срок</span><b>${months} мес</b></div>
    <div><span>Делим на</span><b>${r.rate}</b></div>
    <div><span>Переплата</span><b class="${r.overpay ? "warn" : ""}">+ ${fmt(r.overpay, cur)}</b></div>
    <div class="tot"><span>Сумма к оплате</span><b>${fmt(r.total, cur)}</b></div>`;
}
creditPrice.addEventListener("change", calcCredit);
creditTerm.addEventListener("change", calcCredit);

// --- Анимации появления ----------------------------------------------------

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Плавный подсчёт числа от 0 до значения из data-count (стата на главной).
function animateCount(el: HTMLElement): void {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix || "";
  if (!Number.isFinite(target)) return;
  if (prefersReducedMotion) {
    el.textContent = target.toLocaleString("ru-RU") + suffix;
    return;
  }
  const duration = 1200;
  const start = performance.now();
  function tick(now: number) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toLocaleString("ru-RU") + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        e.target.querySelectorAll<HTMLElement>("[data-count]").forEach(animateCount);
        io.unobserve(e.target);
      }
    });
  },
  { threshold: 0.1 }
);
function observeReveals(): void {
  document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
}
function observeCards(): void {
  document.querySelectorAll<HTMLElement>(".card").forEach((el, i) => {
    el.style.transitionDelay = (i % 4) * 55 + "ms";
    io.observe(el);
  });
}

// --- Старт -----------------------------------------------------------------

(async function init() {
  products = await loadCatalog();

  mountCartDrawer();
  mountWhatsappFloat();

  const heroCount = document.getElementById("heroCount");
  if (heroCount) {
    heroCount.dataset.count = String(products.length);
    animateCount(heroCount);
  }
  document.getElementById("headerSearch")?.addEventListener("click", () => {
    document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" });
    window.setTimeout(() => searchInput.focus(), 500);
  });
  document.getElementById("headerFavorites")?.addEventListener("click", () => toast("Избранное появится скоро"));
  document.getElementById("headerCart")?.addEventListener("click", () => openCart(true));

  renderSidebar();
  renderGrid();
  renderActiveChips();
  renderSales();
  fillCreditModels();
  calcTrade();
  calcCredit();
  observeReveals();
  enhanceSelects();

  // Смена валюты перерисовывает всё, где есть цены (в т.ч. границы цены в сайдбаре).
  onCurrencyChange(() => {
    renderSidebar();
    renderGrid();
    renderSales();
    fillCreditModels();
    calcTrade();
    calcCredit();
  });
})();
