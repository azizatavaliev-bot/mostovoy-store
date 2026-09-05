// Логика главной: сайдбар-фильтр (тип товара → подкатегория, бренд, цена),
// поиск, сортировка, калькуляторы рассрочки и обмена, корзина, анимации.
// Данные берутся из CATALOG (живой каталог из Telegram) — см. catalog.ts.
import "./styles.css";
import "./page-loader";
import {
  cartAdd,
  cartCount,
  convertPrice,
  fmt,
  getDisplayCurrency,
  handleOrderClick,
  loadCatalog,
  mountCartDrawer,
  mountWhatsappFloat,
  onCurrencyChange,
  openCart,
  setDisplayCurrency,
  toast,
} from "./catalog";
import { enhanceSelects, installment, isInstallmentEligible, mediaHTML, refreshCustomSelect } from "./render";
import { modelKey } from "./variants";
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

const grid = document.getElementById("grid") as HTMLDivElement | null;
const gridEmpty = document.getElementById("gridEmpty") as HTMLParagraphElement | null;
const searchInput = document.getElementById("search") as HTMLInputElement | null;
const sortSel = document.getElementById("sort") as HTMLSelectElement | null;
const hasCatalog = Boolean(grid && gridEmpty && searchInput && sortSel);
let products: Product[] = [];

// --- Валюта в шапке --------------------------------------------------------

const headerCurrency = document.getElementById("headerCurrency") as HTMLButtonElement;
const currencyMenu = document.getElementById("currencyMenu") as HTMLDivElement;
const currencySymbol = document.getElementById("currencySymbol") as HTMLSpanElement;
const CURRENCY_SYMBOLS = { USD: "$", KGS: "с", RUB: "₽" } as const;

function openCurrencyMenu(show: boolean): void {
  currencyMenu.hidden = !show;
  headerCurrency.setAttribute("aria-expanded", String(show));
}

function syncCurrencyMenu(): void {
  const active = getDisplayCurrency();
  currencySymbol.textContent = CURRENCY_SYMBOLS[active];
  headerCurrency.setAttribute("aria-label", `Валюта цен: ${active}`);
  currencyMenu.querySelectorAll<HTMLElement>("[data-currency]").forEach((button) => {
    const selected = button.dataset.currency === active;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

headerCurrency.addEventListener("click", (event) => {
  event.stopPropagation();
  openCurrencyMenu(currencyMenu.hasAttribute("hidden"));
});
currencyMenu.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-currency]");
  if (!button) return;
  setDisplayCurrency(button.dataset.currency || "USD");
  openCurrencyMenu(false);
});
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".home-currency")) openCurrencyMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !currencyMenu.hasAttribute("hidden")) {
    openCurrencyMenu(false);
    headerCurrency.focus();
  }
});
document.addEventListener("currency:change", syncCurrencyMenu);
syncCurrencyMenu();

// --- Избранное -------------------------------------------------------------

const FAVORITES_KEY = "mostovoy_favorites";
const FAVORITE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"></path></svg>';

function loadFavorites(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

const favoriteIds = loadFavorites();

function saveFavorites(): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteIds]));
}

function syncFavorites(): void {
  document.querySelectorAll<HTMLElement>("[data-favorite]").forEach((button) => {
    const active = favoriteIds.has(String(button.dataset.favorite));
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Удалить из избранного" : "Добавить в избранное");
  });

  const count = favoriteIds.size;
  const badge = document.getElementById("favoritesCount");
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  document.getElementById("headerFavorites")?.classList.toggle("active", count > 0);
}

function favoriteMedia(product: Product): string {
  const src = curatedPhoto(product.name || "") || product.image || product.img || "";
  return src
    ? `<img src="${optimizedImageUrl(src, 160)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
    : `<span aria-hidden="true">${String(product.name || "?").trim().charAt(0).toUpperCase()}</span>`;
}

function favoriteCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word = mod100 >= 11 && mod100 <= 14 ? "товаров" : mod10 === 1 ? "товар" : mod10 >= 2 && mod10 <= 4 ? "товара" : "товаров";
  return `${count} ${word}`;
}

function renderFavorites(): void {
  const body = document.getElementById("favoritesBody");
  const subtitle = document.getElementById("favoritesSubtitle");
  if (!body || !subtitle) return;

  const list = [...favoriteIds]
    .map((id) => products.find((product) => String(product.id) === id))
    .filter((product): product is Product => Boolean(product));

  subtitle.textContent = list.length ? favoriteCountLabel(list.length) : "Сохраняйте то, что понравилось";
  body.innerHTML = list.length
    ? list
        .map((product) => {
          const price = product.salePrice != null && (product.discountPercent || 0) > 0 ? product.salePrice : product.price;
          return `<article class="favorite-item">
            <a class="favorite-item__media" href="product.html?id=${encodeURIComponent(product.id)}">${favoriteMedia(product)}</a>
            <div class="favorite-item__copy">
              <a href="product.html?id=${encodeURIComponent(product.id)}">${product.name}</a>
              <span>${[product.brand, product.category].filter(Boolean).join(" · ")}</span>
              <b>${fmt(price, product.currency)}</b>
            </div>
            <button type="button" class="favorite-item__remove" data-favorite="${product.id}" aria-label="Удалить из избранного">✕</button>
          </article>`;
        })
        .join("")
    : `<div class="favorites__empty">
        <span>${FAVORITE_ICON}</span>
        <h4>В избранном пока пусто</h4>
        <p>Нажмите на сердечко у товара — он сохранится здесь.</p>
      </div>`;
}

function openFavorites(show: boolean): void {
  document.getElementById("favoritesOverlay")?.classList.toggle("show", show);
  document.getElementById("favoritesDrawer")?.classList.toggle("open", show);
  document.getElementById("headerFavorites")?.setAttribute("aria-expanded", String(show));
  document.body.classList.toggle("noscroll", show);
  if (show) renderFavorites();
}

function mountFavorites(): void {
  const overlay = document.createElement("button");
  overlay.type = "button";
  overlay.className = "favorites__overlay";
  overlay.id = "favoritesOverlay";
  overlay.setAttribute("aria-label", "Закрыть избранное");

  const drawer = document.createElement("aside");
  drawer.className = "favorites";
  drawer.id = "favoritesDrawer";
  drawer.setAttribute("aria-label", "Избранные товары");
  drawer.innerHTML = `
    <div class="favorites__head">
      <div><h3>Избранное</h3><p id="favoritesSubtitle"></p></div>
      <button type="button" class="favorites__close" aria-label="Закрыть">✕</button>
    </div>
    <div class="favorites__body" id="favoritesBody"></div>
    <div class="favorites__foot">
      <button type="button" class="btn favorites__catalog">Смотреть каталог</button>
    </div>`;

  document.body.append(overlay, drawer);
  overlay.addEventListener("click", () => openFavorites(false));
  drawer.querySelector(".favorites__close")?.addEventListener("click", () => openFavorites(false));
  drawer.querySelector(".favorites__catalog")?.addEventListener("click", () => {
    openFavorites(false);
    if (hasCatalog) document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" });
    else window.location.href = "catalog.html#catalog";
  });
  document.getElementById("headerFavorites")?.addEventListener("click", () => openFavorites(true));
  renderFavorites();
  syncFavorites();
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-favorite]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const id = String(button.dataset.favorite);
  const wasFavorite = favoriteIds.has(id);
  if (wasFavorite) favoriteIds.delete(id);
  else favoriteIds.add(id);
  saveFavorites();
  syncFavorites();
  renderFavorites();
  toast(wasFavorite ? "Удалено из избранного" : "Добавлено в избранное");
});

// --- Быстрый поиск из шапки -----------------------------------------------

const homeSearch = document.getElementById("homeSearch") as HTMLDivElement;
const headerSearch = document.getElementById("headerSearch") as HTMLButtonElement;
const homeSearchInput = document.getElementById("homeSearchInput") as HTMLInputElement;
const homeSearchResults = document.getElementById("homeSearchResults") as HTMLDivElement;
let homeSearchMatches: Product[] = [];
let homeSearchActive = -1;

const normalizeSearch = (value: string): string =>
  value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

function productSearchText(product: Product): string {
  return normalizeSearch(
    [product.name, product.brand, product.group, product.category, product.color, product.storage]
      .filter(Boolean)
      .join(" ")
  );
}

function compactSearchMedia(product: Product): string {
  const src = curatedPhoto(product.name || "") || product.image || product.img || "";
  const fallback = String(product.name || "?").trim().charAt(0).toUpperCase();
  return `<span class="home-search__media">
    <span aria-hidden="true">${fallback}</span>
    ${src ? `<img src="${optimizedImageUrl(src, 96)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />` : ""}
  </span>`;
}

function setHomeSearchActive(next: number): void {
  const items = [...homeSearchResults.querySelectorAll<HTMLAnchorElement>("[data-search-result]")];
  if (!items.length) {
    homeSearchActive = -1;
    return;
  }
  homeSearchActive = Math.max(0, Math.min(next, items.length - 1));
  items.forEach((item, index) => {
    item.classList.toggle("active", index === homeSearchActive);
    item.setAttribute("aria-selected", String(index === homeSearchActive));
  });
  items[homeSearchActive]?.scrollIntoView({ block: "nearest" });
}

function renderHomeSearch(): void {
  const query = normalizeSearch(homeSearchInput.value);
  homeSearchActive = -1;
  if (!query) {
    homeSearchMatches = [];
    homeSearchResults.innerHTML = `
      <div class="home-search__hint">
        <span>Быстрый поиск</span>
        <p>Введите название, бренд или модель товара.</p>
        <div class="home-search__examples">
          ${["iPhone 17", "MacBook", "Samsung", "Dyson"].map((item) => `<button type="button" data-search-example="${item}">${item}</button>`).join("")}
        </div>
      </div>`;
    return;
  }

  const terms = query.split(" ").filter(Boolean);
  homeSearchMatches = products.filter((product) => {
    const text = productSearchText(product);
    return terms.every((term) => text.includes(term));
  });

  if (!homeSearchMatches.length) {
    homeSearchResults.innerHTML = `
      <div class="home-search__empty">
        <b>Ничего не найдено</b>
        <p>Проверьте название или попробуйте найти товар по бренду.</p>
      </div>`;
    return;
  }

  const visible = homeSearchMatches.slice(0, 6);
  homeSearchResults.innerHTML = `
    <p class="home-search__count">Найдено ${homeSearchMatches.length}</p>
    <div class="home-search__list" role="listbox">
      ${visible
        .map(
          (product, index) => `
            <a class="home-search__result" data-search-result="${index}" role="option"
               href="product.html?id=${encodeURIComponent(product.id)}" aria-selected="false">
              ${compactSearchMedia(product)}
              <span class="home-search__resultCopy">
                <b>${product.name}</b>
                <small>${[product.brand, product.category, product.color].filter(Boolean).join(" · ")}</small>
              </span>
              <strong>${fmt(product.price, product.currency)}</strong>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
            </a>`
        )
        .join("")}
    </div>
    <button type="button" class="home-search__all" id="homeSearchAll">
      Показать все результаты <span>${homeSearchMatches.length}</span>
    </button>`;
}

function openHomeSearch(show: boolean): void {
  homeSearch.hidden = !show;
  headerSearch.setAttribute("aria-expanded", String(show));
  document.body.classList.toggle("search-open", show);
  if (show) {
    renderHomeSearch();
    window.setTimeout(() => homeSearchInput.focus(), 30);
  } else {
    homeSearchInput.value = "";
    homeSearchActive = -1;
  }
}

function showAllSearchResults(): void {
  const query = homeSearchInput.value.trim();
  if (!hasCatalog || !searchInput) {
    window.location.href = `catalog.html?q=${encodeURIComponent(query)}#catalog`;
    return;
  }
  searchInput.value = query;
  state.q = query;
  renderGrid();
  openHomeSearch(false);
  document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" });
  window.setTimeout(() => searchInput.focus(), 500);
}

headerSearch.addEventListener("click", () => openHomeSearch(true));
document.getElementById("homeSearchClose")?.addEventListener("click", () => openHomeSearch(false));
document.getElementById("homeSearchBackdrop")?.addEventListener("click", () => openHomeSearch(false));
homeSearchInput.addEventListener("input", renderHomeSearch);
homeSearchResults.addEventListener("click", (event) => {
  const example = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-search-example]");
  if (example) {
    homeSearchInput.value = example.dataset.searchExample || "";
    renderHomeSearch();
    homeSearchInput.focus();
    return;
  }
  if ((event.target as HTMLElement).closest("#homeSearchAll")) showAllSearchResults();
});
homeSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    openHomeSearch(false);
    headerSearch.focus();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setHomeSearchActive(homeSearchActive + 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    setHomeSearchActive(homeSearchActive <= 0 ? 0 : homeSearchActive - 1);
    return;
  }
  if (event.key === "Enter" && homeSearchMatches.length) {
    event.preventDefault();
    // Стрелками выбрали конкретный товар — открываем его. Просто набрали
    // текст и нажали Enter — остаёмся на каталоге и показываем все совпадения,
    // а не угадываем один товар и не уводим полной перезагрузкой страницы.
    if (homeSearchActive >= 0) {
      const target = homeSearchMatches[homeSearchActive];
      window.location.href = `product.html?id=${encodeURIComponent(target.id)}`;
    } else {
      showAllSearchResults();
    }
  }
});

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
  const sidebarBody = document.getElementById("sidebarBody");
  if (!sidebarBody) return;
  const bounds = priceBounds();
  const groups = groupsOf();
  const cats = categoriesOf(state.group);
  const brands = brandsOf(state.group, state.category);

  sidebarBody.innerHTML = `
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
  const body = document.getElementById("sidebarBody");
  if (!body) return;

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
  const el = document.getElementById("activeChips");
  if (!el) return;
  const chips: Chip[] = [];
  if (state.group) chips.push({ label: state.group, clear: () => { state.group = null; state.category = null; state.brands = new Set(); } });
  if (state.category) chips.push({ label: state.category, clear: () => { state.category = null; } });
  state.brands.forEach((b) => chips.push({ label: b, clear: () => state.brands.delete(b) }));
  if (state.min != null) chips.push({ label: `от ${state.min.toLocaleString("ru-RU")}`, clear: () => { state.min = null; } });
  if (state.max != null) chips.push({ label: `до ${state.max.toLocaleString("ru-RU")}`, clear: () => { state.max = null; } });

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
  const badge = document.getElementById("filtersCount") as HTMLSpanElement | null;
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const headerBadge = document.getElementById("headerFiltersCount") as HTMLSpanElement | null;
  if (headerBadge) {
    headerBadge.textContent = String(count);
    headerBadge.hidden = count === 0;
  }
}

// Мобильный сайдбар — выезжающая панель, как корзина.
function openFilters(show: boolean): void {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const headerFilters = document.getElementById("headerFilters");
  if (!sidebar || !overlay || !headerFilters) {
    window.location.href = "catalog.html#catalog";
    return;
  }
  sidebar.classList.toggle("open", show);
  overlay.classList.toggle("show", show);
  headerFilters.setAttribute("aria-expanded", String(show));
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
    const queries = state.q
      .toLowerCase()
      .split("|")
      .map((query) => query.trim())
      .filter(Boolean);
    list = list.filter((p) => {
      const haystack = `${p.name} ${p.brand || ""} ${p.category || ""}`.toLowerCase();
      return queries.some((query) => haystack.includes(query));
    });
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
  return mediaHTML({ ...p, tone: p.swatches[idx][1], forceSvg: true }, "card__media");
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

// variantCount > 1: карточка представляет несколько конфигураций одной
// модели (память/связь/цвет разные строки в базе) — цена «от», без деталей
// конкретной строки, выбор конфигурации происходит на странице товара.
function cardHTML(p: Product, variantCount = 1): string {
  const hasDiscount = (p.discountPercent || 0) > 0 && p.salePrice != null && p.salePrice < p.price;
  const effectivePrice = hasDiscount ? (p.salePrice as number) : p.price;
  const monthly = isInstallmentEligible(p) ? installment(effectivePrice, 12).monthly : null;
  const colorName = p.swatches?.length ? p.swatches[cardColor.get(p.id) || 0][0] : p.color;
  const specification =
    variantCount > 1 ? p.category || "" : [colorName || p.category, p.storage, p.variant].filter(Boolean).join(" · ");
  const priceLabel = variantCount > 1 ? "от " : "";
  const badge = hasDiscount
    ? `<span class="card__badge card__badge--sale">${p.discountLabel || `-${p.discountPercent}%`}</span>`
    : p.badge
    ? `<span class="card__badge">${p.badge}</span>`
    : `<span class="card__badge" style="visibility:hidden">·</span>`;
  return `<article class="card ${p.available ? "" : "card--out"}" data-card="${p.id}">
    <button type="button" class="card__favorite ${favoriteIds.has(String(p.id)) ? "active" : ""}"
      data-favorite="${p.id}" aria-label="${favoriteIds.has(String(p.id)) ? "Удалить из избранного" : "Добавить в избранное"}"
      aria-pressed="${favoriteIds.has(String(p.id))}">${FAVORITE_ICON}</button>
    <a class="card__link" href="product.html?id=${encodeURIComponent(p.id)}">
      ${badge}
      ${variantCount > 1 ? mediaHTML(p, "card__media") : cardMedia(p)}
    </a>
    ${variantCount > 1 ? "" : swatchesHTML(p)}
    <a class="card__link card__link--text" href="product.html?id=${encodeURIComponent(p.id)}">
      <h3 class="card__name">${p.name}</h3>
      <p class="card__spec">${specification}${p.available ? "" : " · нет в наличии"}</p>
      <div class="card__price">
        ${hasDiscount ? `<span class="card__old">${fmt(p.price, p.currency)}</span> ` : ""}${priceLabel}${fmt(effectivePrice, p.currency)}
        ${monthly == null ? "" : `<span class="card__from">/ от ${fmt(monthly, p.currency)} в мес.</span>`}
      </div>
    </a>
    <button type="button" class="card__add" data-add="${p.id}">В корзину</button>
  </article>`;
}

// Схлопывает отфильтрованный список в одну карточку на модель: разные строки
// одного товара (память/связь/цвет) в Telegram превращались в десятки
// карточек — здесь остаётся самая дешёвая конфигурация каждой модели,
// сортировка/фильтры перед этим уже применены к list.
function collapseToModels(list: Product[]): { product: Product; count: number }[] {
  const order: string[] = [];
  const byKey = new Map<string, Product[]>();
  for (const p of list) {
    const k = modelKey(p);
    const arr = byKey.get(k);
    if (arr) arr.push(p);
    else {
      byKey.set(k, [p]);
      order.push(k);
    }
  }
  return order.map((k) => {
    const group = byKey.get(k)!;
    const cheapest = group.reduce((min, p) => (p.price < min.price ? p : min), group[0]);
    return { product: cheapest, count: group.length };
  });
}

function renderGrid(): void {
  if (!grid || !gridEmpty) return;
  const list = filtered();
  gridEmpty.hidden = list.length > 0;
  grid.innerHTML = collapseToModels(list)
    .map(({ product, count }) => cardHTML(product, count))
    .join("");
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

// --- Линейка продуктов перед каталогом ------------------------------------

const PRODUCT_FAMILIES = [
  {
    key: "iphone",
    name: "iPhone",
    query: "iPhone",
    description: "Актуальные модели iPhone.",
    fallbackImage: "/images/iphone-hero.webp",
    fallbackVisual: "image",
    match: (product: Product) => /^iphone\b/i.test(product.name),
  },
  {
    key: "airpods",
    name: "AirPods",
    query: "AirPods",
    description: "Наушники для музыки и звонков.",
    fallbackImage: "/images/hero-airpods.webp",
    fallbackVisual: "image",
    match: (product: Product) => /^airpods\b/i.test(product.name),
  },
  {
    key: "ipad",
    name: "iPad",
    query: "iPad",
    description: "Для учёбы, работы и творчества.",
    fallbackImage: "/images/hero-ipad-transparent.webp",
    fallbackVisual: "image",
    match: (product: Product) => /^ipad\b/i.test(product.name),
  },
  {
    key: "mac",
    name: "MacBook",
    query: "MacBook",
    description: "Мощность для больших задач.",
    fallbackImage: "/images/hero-macbook-transparent.webp",
    fallbackVisual: "image",
    match: (product: Product) => /^macbook\b/i.test(product.name),
  },
  {
    key: "watch",
    name: "Apple Watch",
    query: "Apple Watch",
    description: "Здоровье, связь и стиль.",
    fallbackImage: "/images/apple-watch-series.png",
    fallbackVisual: "image",
    match: (product: Product) => /^apple watch\b/i.test(product.name),
  },
] as const;

const OTHER_PRODUCT_FAMILIES = [
  {
    key: "whoop",
    name: "Whoop",
    query: "Whoop",
    description: "Трекер восстановления, сна и нагрузки.",
    visual: "video",
    match: (product: Product) => /whoop/i.test(`${product.name} ${product.brand}`),
  },
  {
    key: "console",
    name: "Приставки",
    // Символ | означает «любой из вариантов»: в каталоге нет одной общей
    // строки с названиями всех консолей.
    query: "PlayStation|Xbox|Nintendo|Switch|Steam Deck",
    description: "Игры, подписки и домашние развлечения.",
    visual: "console",
    match: (product: Product) => /playstation|xbox|nintendo|switch|steam deck/i.test(`${product.name} ${product.brand} ${product.category}`),
  },
  {
    key: "garmin",
    name: "Garmin",
    query: "Garmin",
    description: "Спорт, навигация и автономные часы.",
    visual: "garmin",
    match: (product: Product) => /garmin/i.test(`${product.name} ${product.brand}`),
  },
  {
    key: "meta",
    name: "Очки Meta",
    query: "Meta Ray-Ban",
    description: "Умные очки, камера и AI на каждый день.",
    visual: "meta",
    match: (product: Product) => /meta.*ray-ban|ray-ban|oakley/i.test(`${product.name} ${product.brand}`),
  },
  {
    key: "hairdryer",
    name: "Фены",
    query: "Dyson фен",
    description: "Уход за волосами и компактный стайлинг.",
    visual: "hairdryer",
    match: (product: Product) => /dyson/i.test(`${product.name} ${product.brand}`),
  },
  {
    key: "shaver",
    name: "Бритвы",
    // В каталоге OneBlade размечен как «Триммеры», а не «Бритвы».
    // Один бренд — надёжный поиск, тогда карточка не ведёт в пустую выдачу.
    query: "Philips",
    description: "Электробритвы и триммеры для ухода.",
    visual: "shaver",
    match: (product: Product) => /philips|oneblade|бритв|триммер/i.test(`${product.name} ${product.brand} ${product.category}`),
  },
] as const;

function familyProduct(match: (product: Product) => boolean): Product | null {
  const matches = products.filter(match);
  return (
    matches.find((product) => product.available && Boolean(product.image || product.img)) ||
    matches.find((product) => Boolean(product.image || product.img)) ||
    matches[0] ||
    null
  );
}

function applyProductLineQuery(query: string): void {
  if (!hasCatalog || !searchInput) {
    window.location.href = `catalog.html?q=${encodeURIComponent(query)}#catalog`;
    return;
  }
  state.group = null;
  state.category = null;
  state.brands = new Set();
  state.min = null;
  state.max = null;
  state.q = query;
  searchInput.value = query;
  renderSidebar();
  renderGrid();
  renderActiveChips();
  document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" });
}

function otherFamilyVisual(kind: (typeof OTHER_PRODUCT_FAMILIES)[number]["visual"], product: Product | null): string {
  // Кураторское фото на белом фоне в приоритете: сырые фото из базы бывают
  // со скриншотами прозрачности/коллажами поставщика (см. mediaHTML).
  const source = (product && curatedPhoto(product.name || "")) || product?.image || product?.img;
  if (source) {
    return `<img class="product-family__image product-family__image--contain" src="${optimizedImageUrl(source, 640)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`;
  }

  if (kind === "video") {
    return `
      <img class="product-family__image" src="/images/whoop.jpg" alt="" loading="lazy" decoding="async" />
      <span class="product-family__glass product-family__glass--whoop">WHOOP</span>`;
  }

  if (kind === "console") {
    return `
      <span class="product-family__console">
        <span></span><i></i><b></b>
      </span>`;
  }

  if (kind === "garmin") {
    return `
      <img class="product-family__image product-family__image--contain" src="/images/garmin-fenix-8.jpg" alt="" loading="lazy" decoding="async" />`;
  }

  if (kind === "hairdryer") {
    return `
      <img class="product-family__image product-family__image--contain" src="/images/dyson-hair-dryer.jpg" alt="" loading="lazy" decoding="async" />`;
  }

  if (kind === "shaver") {
    return `
      <img class="product-family__image product-family__image--contain" src="/images/philips-shaver.jpg" alt="" loading="lazy" decoding="async" />`;
  }

  return `
    <span class="product-family__glasses">
      <span></span><span></span><i></i>
    </span>`;
}

// Карточка берёт мягкий акцент из реального фото товара. Белый/серый фон
// пропускаем: он не должен становиться свечением. Изображения загружаются через
// same-origin WebP-прокси, поэтому canvas доступен без передачи данных наружу.
function applyProductFamilyImageTheme(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>(".product-family__stage img").forEach((image) => {
    const setAccent = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const canvas = document.createElement("canvas");
      const size = 48;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      try {
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let weight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const saturation = max - min;
          // Не учитываем почти белый фон, тени и нейтральный металл.
          if (max > 236 || saturation < 44 || max < 36) continue;
          const pixelWeight = saturation * (max / 255);
          red += r * pixelWeight;
          green += g * pixelWeight;
          blue += b * pixelWeight;
          weight += pixelWeight;
        }
        if (!weight) return;
        const averageRed = Math.round(red / weight);
        const averageGreen = Math.round(green / weight);
        const averageBlue = Math.round(blue / weight);
        // У чёрной и очень тёмной техники оставляем чистую карточку:
        // затемнённое свечение выглядело бы как грязная тень.
        const brightness = averageRed * 0.2126 + averageGreen * 0.7152 + averageBlue * 0.0722;
        if (brightness < 82) return;
        const stage = image.closest<HTMLElement>(".product-family__stage");
        if (!stage) return;
        stage.style.setProperty("--product-glow", `${averageRed}, ${averageGreen}, ${averageBlue}`);
        stage.classList.add("product-family__stage--themed");
      } catch {
        // Внешняя картинка без CORS просто остаётся без цветового свечения.
      }
    };
    if (image.complete) setAccent();
    else image.addEventListener("load", setAccent, { once: true });
  });
}

function appleFamilyVisual(family: (typeof PRODUCT_FAMILIES)[number], product: Product | null): string {
  if (product) return mediaHTML(product, "product-family__media");
  return `<span class="product-family__media">
    <img src="${family.fallbackImage}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />
  </span>`;
}

function renderProductLine(): void {
  const rail = document.getElementById("productLineRail");
  if (!rail) return;

  const families = PRODUCT_FAMILIES.map((family) => ({
    family,
    product: familyProduct(family.match),
  }));

  rail.innerHTML = families
    .map(
      ({ family, product }) => `
        <button type="button" class="product-family reveal" data-product-family="${family.key}"
          aria-label="Смотреть ${family.name} в каталоге">
          <span class="product-family__stage">
            <span class="product-family__availability">${product?.available ? "В наличии" : "Под заказ"}</span>
            ${appleFamilyVisual(family, product)}
          </span>
          <span class="product-family__copy">
            <strong>${family.name}</strong>
            <small>${family.description}</small>
            <span class="product-family__action">Смотреть <b aria-hidden="true">↗</b></span>
          </span>
        </button>`
    )
    .join("");

  rail.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-product-family]");
    if (!button) return;
    const family = PRODUCT_FAMILIES.find((item) => item.key === button.dataset.productFamily);
    if (!family) return;
    applyProductLineQuery(family.query);
  });

  const otherRail = document.getElementById("otherProductLineRail");
  if (!otherRail) return;

  otherRail.innerHTML = OTHER_PRODUCT_FAMILIES
    .map(
      (family) => {
        const product = familyProduct(family.match);
        return `
        <button type="button" class="product-family product-family--other reveal" data-other-product-family="${family.key}"
          aria-label="Смотреть ${family.name} в каталоге">
          <span class="product-family__stage product-family__stage--${family.visual}">
            <span class="product-family__media product-family__media--concept">
              ${otherFamilyVisual(family.visual, product)}
            </span>
          </span>
          <span class="product-family__copy">
            <strong>${family.name}</strong>
            <small>${family.description}</small>
            <span class="product-family__action">Смотреть <b aria-hidden="true">↗</b></span>
          </span>
        </button>`;
      }
    )
    .join("");

  otherRail.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-other-product-family]");
    if (!button) return;
    const family = OTHER_PRODUCT_FAMILIES.find((item) => item.key === button.dataset.otherProductFamily);
    if (!family) return;
    applyProductLineQuery(family.query);
  });

  applyProductFamilyImageTheme(rail);
  applyProductFamilyImageTheme(otherRail);
}

function conveyorButton(item: string, query: string, kind: "brand" | "gadget"): string {
  return `<button type="button" data-conveyor-query="${query}" data-conveyor-kind="${kind}">${item}</button>`;
}

function renderConveyors(): void {
  const gadgetTrack = document.getElementById("gadgetConveyorTrack");
  if (gadgetTrack) {
    const items = OTHER_PRODUCT_FAMILIES.map((family) => conveyorButton(family.name, family.query, "gadget"));
    gadgetTrack.innerHTML = [...items, ...items, ...items].join("");
  }

  const brandTrack = document.getElementById("brandConveyorTrack");
  if (!brandTrack) return;
  const fallback = ["Apple", "Samsung", "Garmin", "Sony", "DJI", "Meta", "Nintendo", "Philips", "Amazon", "Valve"];
  const brands = [...new Set(products.map((product) => product.brand).filter(Boolean))]
    .sort((a, b) => (a as string).localeCompare(b as string, "ru")) as string[];
  const items = (brands.length ? brands : fallback).map((brand) => conveyorButton(brand, brand, "brand"));
  brandTrack.innerHTML = [...items, ...items, ...items].join("");
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-conveyor-query]");
  if (!button) return;
  applyProductLineQuery(button.dataset.conveyorQuery || "");
});

// --- Поиск, сортировка, мобильный сайдбар ----------------------------------

if (hasCatalog && grid && searchInput && sortSel) {
  searchInput.addEventListener("input", (e) => {
    state.q = (e.target as HTMLInputElement).value.trim();
    renderGrid();
  });

  sortSel.addEventListener("change", (e) => {
    state.sort = (e.target as HTMLSelectElement).value as FilterState["sort"];
    renderGrid();
  });

  document.getElementById("btnOpenFilters")?.addEventListener("click", () => openFilters(true));
  document.getElementById("headerFilters")?.addEventListener("click", () => openFilters(true));
  document.getElementById("btnCloseFilters")?.addEventListener("click", () => openFilters(false));
  document.getElementById("sidebarOverlay")?.addEventListener("click", () => openFilters(false));

  // На телефоне фильтры доступны из шапки на всём протяжении каталога.
  const headerFilters = document.getElementById("headerFilters") as HTMLButtonElement | null;
  const catalogSection = document.getElementById("catalog");
  if (headerFilters && catalogSection) {
    new IntersectionObserver(([entry]) => {
      headerFilters.classList.toggle("visible", entry.isIntersecting);
      headerFilters.tabIndex = entry.isIntersecting ? 0 : -1;
    }, { threshold: 0 }).observe(catalogSection);
  }

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
    }
  });
} else {
  document.getElementById("headerFilters")?.addEventListener("click", () => {
    window.location.href = "catalog.html#catalog";
  });
}

const headerCart = document.getElementById("headerCart") as HTMLButtonElement;
const headerCartLabel = document.getElementById("headerCartLabel") as HTMLSpanElement;

function syncHeaderCart(): void {
  const hasItems = cartCount() > 0;
  headerCartLabel.textContent = hasItems ? "Купить" : "Корзина";
  headerCart.setAttribute("aria-label", hasItems ? "Купить товары из корзины" : "Корзина пуста");
  headerCart.classList.toggle("has-items", hasItems);
}

function animateToCart(addButton: HTMLElement): void {
  const card = addButton.closest<HTMLElement>(".card");
  const media = card?.querySelector<HTMLElement>(".card__media");
  const target = headerCart.getBoundingClientRect();
  if (!media || target.width === 0 || prefersReducedMotion) {
    headerCart.classList.add("cart-pop");
    window.setTimeout(() => headerCart.classList.remove("cart-pop"), 420);
    return;
  }

  const source = media.getBoundingClientRect();
  const size = Math.min(source.width, source.height, 132);
  const fly = document.createElement("div");
  fly.className = "cart-fly";
  fly.style.width = `${size}px`;
  fly.style.height = `${size}px`;
  fly.style.left = `${source.left + source.width / 2 - size / 2}px`;
  fly.style.top = `${source.top + source.height / 2 - size / 2}px`;
  fly.style.setProperty("--cart-fly-x", `${target.left + target.width / 2 - (source.left + source.width / 2)}px`);
  fly.style.setProperty("--cart-fly-y", `${target.top + target.height / 2 - (source.top + source.height / 2)}px`);

  const image = media.querySelector<HTMLImageElement>("img");
  const visual = image || media.querySelector<SVGElement>("svg");
  if (visual) {
    const clone = visual.cloneNode(true) as Element;
    clone.removeAttribute("onload");
    clone.removeAttribute("onerror");
    clone.removeAttribute("loading");
    fly.appendChild(clone);
  }
  document.body.appendChild(fly);
  requestAnimationFrame(() => fly.classList.add("go"));
  window.setTimeout(() => {
    fly.remove();
    headerCart.classList.add("cart-pop");
    window.setTimeout(() => headerCart.classList.remove("cart-pop"), 420);
  }, 680);
}

document.addEventListener("click", (e) => {
  // Корзина: кнопка на любой карточке, включая блок акций.
  const target = e.target as HTMLElement;
  const add = target.closest<HTMLElement>("[data-add]");
  if (!add) return;
  e.preventDefault();
  const id = add.dataset.add as string;
  const p = products.find((x) => String(x.id) === String(id));
  const color = p?.swatches?.length ? p.swatches[cardColor.get(id) || 0][0] : null;
  animateToCart(add);
  cartAdd(id, 1, color);
  toast(color ? `Добавлено в корзину · ${color}` : "Добавлено в корзину");
});

document.addEventListener("cart:change", syncHeaderCart);
syncHeaderCart();

// --- Почему мы лучшие ------------------------------------------------------

const WHY: [string, string, string][] = [
  ["🛡️", "Официальная гарантия", "1 год на всю технику"],
  ["✅", "Только оригинал", "Никаких копий и восстановленных под видом новых"],
  ["🔄", "Trade-in", "Обменяем ваш старый телефон с доплатой"],
  ["💳", "Рассрочка", "Выберите удобный срок и ежемесячный платёж"],
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

const tradeModel = document.getElementById("tradeModel") as HTMLSelectElement | null;
const tradeState = document.getElementById("tradeState") as HTMLSelectElement | null;
const tradeResult = document.getElementById("tradeResult") as HTMLElement | null;

// Оценки трейд-ина заданы в долларах (см. index.html).
function calcTrade(): void {
  if (!tradeModel || !tradeState || !tradeResult) return;
  tradeResult.textContent = fmt(+tradeModel.value * +tradeState.value, "USD");
}
tradeModel?.addEventListener("change", calcTrade);
tradeState?.addEventListener("change", calcTrade);

// --- Калькулятор рассрочки -------------------------------------------------

const creditPrice = document.getElementById("creditPrice") as HTMLSelectElement;
const creditTerm = document.getElementById("creditTerm") as HTMLSelectElement;
const crMonthly = document.getElementById("crMonthly") as HTMLElement;
const crBreak = document.getElementById("crBreak") as HTMLElement;
const creditSubmit = document.getElementById("creditSubmit") as HTMLButtonElement;

function fillCreditModels(): void {
  const keep = creditPrice.selectedIndex;
  creditPrice.innerHTML = products
    .filter(isInstallmentEligible)
    .map((p) => `<option value="${p.price}" data-id="${p.id}" data-cur="${p.currency}">${p.name} — ${fmt(p.price, p.currency)}</option>`)
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
creditSubmit.addEventListener("click", () => {
  const opt = creditPrice.options[creditPrice.selectedIndex];
  const product = products.find((item) => String(item.id) === String(opt?.dataset.id));
  if (!product) {
    toast("Сначала выберите товар");
    return;
  }
  const months = +creditTerm.value;
  const result = installment(product.price, months);
  const text = [
    "Здравствуйте! Хочу оформить рассрочку:",
    `Товар: ${product.name}`,
    `Срок: ${months} месяцев`,
    `Стоимость: ${fmt(product.price, product.currency)}`,
    `Платёж в месяц: ${fmt(result.monthly, product.currency)}`,
    `Сумма к оплате: ${fmt(result.total, product.currency)}`,
    "",
    "Подскажите, пожалуйста, как оформить?",
  ].join("\n");
  handleOrderClick(text, [{ productId: String(product.id), quantity: 1 }], "credit");
});

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

function mountHeroRotation(): void {
  const hero = document.querySelector<HTMLElement>(".hero");
  if (!hero) return;

  const products = ["iphone", "macbook", "ipad", "airpods"] as const;
  let productIndex = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    productIndex = (productIndex + 1) % products.length;
    const product = products[productIndex];
    hero.dataset.product = product;
    hero.querySelectorAll<HTMLElement>("[data-hero-copy]").forEach((copy) => {
      copy.setAttribute("aria-hidden", String(copy.dataset.heroCopy !== product));
    });
  }, 2500);
}

mountHeroRotation();

(async function init() {
  products = await loadCatalog();
  const productIds = new Set(products.map((product) => String(product.id)));
  favoriteIds.forEach((id) => {
    if (!productIds.has(id)) favoriteIds.delete(id);
  });
  saveFavorites();

  mountCartDrawer();
  mountFavorites();
  mountWhatsappFloat();

  const heroCount = document.getElementById("heroCount");
  if (heroCount) {
    heroCount.dataset.count = String(products.length);
    animateCount(heroCount);
  }
  headerCart.addEventListener("click", () => openCart(true));

  if (hasCatalog && searchInput) {
    const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim();
    if (initialQuery) {
      state.q = initialQuery;
      searchInput.value = initialQuery;
    }
  }

  renderSidebar();
  renderGrid();
  renderActiveChips();
  renderSales();
  renderProductLine();
  renderConveyors();
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
import { curatedPhoto } from "./curated-photos";
import { optimizedImageUrl } from "./image-url";
