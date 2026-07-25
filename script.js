// Логика главной: фильтры (бренд/категория/поиск/цена/сортировка),
// калькуляторы Zero-рассрочки и обмена, корзина, анимации.
// Данные берутся из CATALOG (живой каталог из Telegram) — см. catalog.js.

const state = { brand: "Все", cat: "Все", q: "", sort: "pop", min: null, max: null };

const grid = document.getElementById("grid");
const gridEmpty = document.getElementById("gridEmpty");
const brandTabs = document.getElementById("brandTabs");
const filters = document.getElementById("filters");
const searchInput = document.getElementById("search");
const sortSel = document.getElementById("sort");
const priceMin = document.getElementById("priceMin");
const priceMax = document.getElementById("priceMax");
const heroVisual = document.getElementById("heroVisual");

let products = [];

const brandsOf = () => ["Все", ...new Set(products.map((p) => p.brand).filter(Boolean))];
const catsOf = (brand) => {
  const src = brand === "Все" ? products : products.filter((p) => p.brand === brand);
  return ["Все", ...new Set(src.map((p) => p.category).filter(Boolean))];
};

function renderBrandTabs() {
  brandTabs.innerHTML = brandsOf()
    .map((b) => `<button class="tab ${b === state.brand ? "active" : ""}" data-brand="${b}">${b}</button>`)
    .join("");
}

function renderFilters() {
  filters.innerHTML = catsOf(state.brand)
    .map((c) => `<button class="chip ${c === state.cat ? "active" : ""}" data-cat="${c}">${c}</button>`)
    .join("");
}

// Границы цены вводятся в валюте отображения — сравниваем в ней же.
function inPriceRange(p) {
  if (state.min == null && state.max == null) return true;
  const shown = convertPrice(p.price, p.currency, getDisplayCurrency());
  if (state.min != null && shown < state.min) return false;
  if (state.max != null && shown > state.max) return false;
  return true;
}

function filtered() {
  let list = products.slice();
  if (state.brand !== "Все") list = list.filter((p) => p.brand === state.brand);
  if (state.cat !== "Все") list = list.filter((p) => p.category === state.cat);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((p) => `${p.name} ${p.brand || ""} ${p.category || ""}`.toLowerCase().includes(q));
  }
  list = list.filter(inPriceRange);

  const shown = (p) => convertPrice(p.price, p.currency, getDisplayCurrency());
  if (state.sort === "asc") list.sort((a, b) => shown(a) - shown(b));
  else if (state.sort === "desc") list.sort((a, b) => shown(b) - shown(a));
  else {
    // «По популярности»: Apple впереди, дальше — порядок каталога.
    const rank = (p) => (p.brand === "Apple" ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || products.indexOf(a) - products.indexOf(b));
  }
  return list;
}

// Выбранный на карточке цвет: id товара → индекс свотча.
const cardColor = new Map();

// Медиа карточки. Для выбранного НЕ первого цвета показываем векторный рендер
// в этом цвете: отдельных фото под каждый цвет у нас нет, а фото первого
// цвета вводило бы в заблуждение.
function cardMedia(p) {
  const idx = cardColor.get(p.id) || 0;
  if (!p.swatches?.length || idx === 0) return mediaHTML(p, "card__media");
  return mediaHTML({ ...p, tone: p.swatches[idx][1], image: null }, "card__media");
}

function swatchesHTML(p) {
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

function cardHTML(p) {
  const monthly = installment(p.price, 12).monthly;
  const colorName = p.swatches?.length ? p.swatches[cardColor.get(p.id) || 0][0] : p.color;
  return `<article class="card ${p.available ? "" : "card--out"}" data-card="${p.id}">
    <a class="card__link" href="product.html?id=${encodeURIComponent(p.id)}">
      ${p.badge ? `<span class="card__badge">${p.badge}</span>` : `<span class="card__badge" style="visibility:hidden">·</span>`}
      ${cardMedia(p)}
    </a>
    ${swatchesHTML(p)}
    <a class="card__link card__link--text" href="product.html?id=${encodeURIComponent(p.id)}">
      <h3 class="card__name">${p.name}</h3>
      <p class="card__spec">${colorName || p.category || ""}${p.available ? "" : " · нет в наличии"}</p>
      <div class="card__price">${fmt(p.price, p.currency)}
        <span class="card__from">/ от ${fmt(monthly, p.currency)} в мес.</span>
      </div>
    </a>
    <button type="button" class="card__add" data-add="${p.id}">В корзину</button>
  </article>`;
}

function renderGrid() {
  const list = filtered();
  gridEmpty.hidden = list.length > 0;
  grid.innerHTML = list.map(cardHTML).join("");
  observeCards();
}

// --- Фильтры --------------------------------------------------------------

brandTabs.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.brand = b.dataset.brand;
  state.cat = "Все";
  renderBrandTabs();
  renderFilters();
  renderGrid();
});

filters.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.cat = c.dataset.cat;
  renderFilters();
  renderGrid();
});

searchInput.addEventListener("input", (e) => {
  state.q = e.target.value.trim();
  renderGrid();
});

sortSel.addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderGrid();
});

const readLimit = (el) => {
  const v = Number.parseFloat(String(el.value).replace(/\s/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
};
[priceMin, priceMax].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", () => {
    state.min = readLimit(priceMin);
    state.max = readLimit(priceMax);
    renderGrid();
  });
});

grid.addEventListener("click", (e) => {
  // Смена цвета прямо в каталоге — без перехода на страницу товара.
  const sw = e.target.closest("[data-sw]");
  if (sw) {
    e.preventDefault();
    const id = sw.dataset.for;
    cardColor.set(id, Number(sw.dataset.sw));
    const p = products.find((x) => String(x.id) === String(id));
    const card = grid.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (p && card) {
      // Перерисовываем только эту карточку, чтобы не дёргать весь список.
      card.querySelector(".card__media").outerHTML = cardMedia(p);
      card.querySelector(".card__sw").outerHTML = swatchesHTML(p);
      card.querySelector(".card__spec").textContent =
        p.swatches[cardColor.get(id)][0] + (p.available ? "" : " · нет в наличии");
    }
    return;
  }

  // Корзина: кнопка на карточке (карточка — ссылка, поэтому гасим переход).
  const add = e.target.closest("[data-add]");
  if (!add) return;
  e.preventDefault();
  const id = add.dataset.add;
  const p = products.find((x) => String(x.id) === String(id));
  const color = p?.swatches?.length ? p.swatches[cardColor.get(id) || 0][0] : null;
  cartAdd(id, 1, color);
  toast(color ? `Добавлено в корзину · ${color}` : "Добавлено в корзину");
});

// --- Почему мы лучшие ------------------------------------------------------

const WHY = [
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

const tradeModel = document.getElementById("tradeModel");
const tradeState = document.getElementById("tradeState");
const tradeResult = document.getElementById("tradeResult");

// Оценки трейд-ина заданы в долларах (см. index.html).
function calcTrade() {
  tradeResult.textContent = fmt(+tradeModel.value * +tradeState.value, "USD");
}
tradeModel.addEventListener("change", calcTrade);
tradeState.addEventListener("change", calcTrade);

// --- Калькулятор рассрочки Zero --------------------------------------------

const creditPrice = document.getElementById("creditPrice");
const creditTerm = document.getElementById("creditTerm");
const crMonthly = document.getElementById("crMonthly");
const crBreak = document.getElementById("crBreak");

function fillCreditModels() {
  const keep = creditPrice.selectedIndex;
  creditPrice.innerHTML = products
    .map((p) => `<option value="${p.price}" data-cur="${p.currency}">${p.name} — ${fmt(p.price, p.currency)}</option>`)
    .join("");
  if (keep >= 0 && keep < creditPrice.options.length) creditPrice.selectedIndex = keep;
  creditPrice._cs?.build();
  creditPrice._cs?.update();
}

function calcCredit() {
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

const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  },
  { threshold: 0.1 }
);
function observeReveals() {
  document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
}
function observeCards() {
  document.querySelectorAll(".card").forEach((el, i) => {
    el.style.transitionDelay = (i % 4) * 55 + "ms";
    io.observe(el);
  });
}

// --- Старт -----------------------------------------------------------------

(async function init() {
  products = await loadCatalog();

  mountHeaderControls();
  mountCartDrawer();

  // В герое показываем флагманский iPhone — витринный товар магазина.
  const heroProduct =
    products.find((p) => /iphone 16 pro max/i.test(p.name)) ||
    products.find((p) => /iphone/i.test(p.name)) ||
    products[0];
  if (heroVisual && heroProduct) heroVisual.innerHTML = mediaHTML(heroProduct, "hero__phone");
  const heroCount = document.getElementById("heroCount");
  if (heroCount) heroCount.textContent = String(products.length);

  renderBrandTabs();
  renderFilters();
  renderGrid();
  fillCreditModels();
  calcTrade();
  calcCredit();
  observeReveals();
  enhanceSelects();

  // Смена валюты перерисовывает всё, где есть цены.
  onCurrencyChange(() => {
    renderGrid();
    fillCreditModels();
    calcTrade();
    calcCredit();
  });
})();
