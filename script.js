// --- Hero: крупный телефон ---
const heroVisual = document.getElementById("heroVisual");
if (heroVisual) heroVisual.innerHTML = mediaHTML(PHONES[0], "hero__phone");

// --- Состояние фильтров ---
const state = { brand: "Все", gen: "Все", q: "", sort: "pop" };
const grid = document.getElementById("grid");
const gridEmpty = document.getElementById("gridEmpty");
const brandTabs = document.getElementById("brandTabs");
const filters = document.getElementById("filters");
const searchInput = document.getElementById("search");
const sortSel = document.getElementById("sort");

const BRANDS = ["Все", "Apple", "Samsung"];

function gensFor(brand) {
  const src = brand === "Все" ? PHONES : PHONES.filter((p) => p.brand === brand);
  return ["Все", ...[...new Set(src.map((p) => p.gen))]];
}
const genLabel = (g) => (g === "Все" ? "Все" : (state.brand === "Samsung" || /^[SA]/.test(g) ? "Galaxy " + g : "iPhone " + g));

function renderBrandTabs() {
  brandTabs.innerHTML = BRANDS.map(
    (b) => `<button class="tab ${b === state.brand ? "active" : ""}" data-brand="${b}">${b}</button>`
  ).join("");
}

function renderFilters() {
  filters.innerHTML = gensFor(state.brand)
    .map((g) => `<button class="chip ${g === state.gen ? "active" : ""}" data-gen="${g}">${genLabel(g)}</button>`)
    .join("");
}

function filtered() {
  let list = PHONES.slice();
  if (state.brand !== "Все") list = list.filter((p) => p.brand === state.brand);
  if (state.gen !== "Все") list = list.filter((p) => p.gen === state.gen);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((p) => (p.name + " " + p.chip).toLowerCase().includes(q));
  }
  if (state.sort === "asc") list.sort((a, b) => a.price - b.price);
  else if (state.sort === "desc") list.sort((a, b) => b.price - a.price);
  return list;
}

function renderGrid() {
  const list = filtered();
  gridEmpty.hidden = list.length > 0;
  grid.innerHTML = list
    .map(
      (p) => `<a class="card" href="product.html?id=${p.id}">
        ${p.badge ? `<span class="card__badge">${p.badge}</span>` : `<span class="card__badge" style="visibility:hidden">·</span>`}
        ${mediaHTML(p, "card__media")}
        <h3 class="card__name">${p.name}</h3>
        <p class="card__spec">${p.display.split("″")[0]}″ · ${p.chip}</p>
        <div class="card__price">${fmt(p.price)} <span class="card__from">/ от ${fmt(Math.round(p.price / 24))} в мес.</span></div>
      </a>`
    )
    .join("");
  observeCards();
}

brandTabs.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.brand = b.dataset.brand;
  state.gen = "Все";
  renderBrandTabs();
  renderFilters();
  renderGrid();
});
filters.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.gen = c.dataset.gen;
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

// --- Почему мы лучшие ---
const WHY = [
  ["🛡️", "Официальная гарантия", "1 год на всю технику Apple и Samsung"],
  ["✅", "Только оригинал", "Никаких копий и восстановленных под видом новых"],
  ["🔄", "Trade-in", "Обменяем ваш старый телефон с доплатой"],
  ["💳", "Рассрочка 0%", "Без переплат и справок, оформление за 15 минут"],
  ["🚚", "Быстрая доставка", "По Бишкеку 1–2 дня, по всему Кыргызстану"],
  ["🛠️", "Свой сервис", "Настройка, перенос данных и ремонт на месте"],
  ["⭐", "50 000+ клиентов", "Нам доверяют по всей стране 12 лет"],
  ["🏆", "#1 в Кыргызстане", "Топ-продаж смартфонов и аксессуаров"],
];
const whyGrid = document.getElementById("whyGrid");
if (whyGrid)
  whyGrid.innerHTML = WHY.map(
    (w) => `<div class="wcard reveal"><span class="wcard__ico">${w[0]}</span><b>${w[1]}</b><p>${w[2]}</p></div>`
  ).join("");

// --- Калькулятор обмена ---
const tradeModel = document.getElementById("tradeModel");
const tradeState = document.getElementById("tradeState");
const tradeResult = document.getElementById("tradeResult");
function calcTrade() {
  tradeResult.textContent = fmt(Math.round(+tradeModel.value * +tradeState.value));
}
tradeModel.addEventListener("change", calcTrade);
tradeState.addEventListener("change", calcTrade);

// --- Калькулятор рассрочки (пошаговый) ---
const creditPrice = document.getElementById("creditPrice");
const creditDown = document.getElementById("creditDown");
const creditTerm = document.getElementById("creditTerm");
const creditRate = document.getElementById("creditRate");
const crMonthly = document.getElementById("crMonthly");
const crBreak = document.getElementById("crBreak");

creditPrice.innerHTML = PHONES.map((p) => `<option value="${p.price}">${p.name} — ${fmt(p.price)}</option>`).join("");

function calcCredit() {
  const price = +creditPrice.value;
  const down = Math.round(price * +creditDown.value);
  const principal = price - down;
  const months = +creditTerm.value;
  const rate = +creditRate.value;
  const r = installment(principal, months, rate);
  crMonthly.textContent = fmt(r.monthly);
  crBreak.innerHTML = `
    <div><span>Цена</span><b>${fmt(price)}</b></div>
    <div><span>Первый взнос</span><b>${down ? fmt(down) : "0 ₽"}</b></div>
    <div><span>Сумма рассрочки</span><b>${fmt(principal)}</b></div>
    <div><span>Ставка</span><b>${rate === 0 ? "0% (промо)" : rate + "% годовых"}</b></div>
    <div><span>Переплата</span><b class="${r.overpay ? "warn" : ""}">${r.overpay ? "+ " + fmt(r.overpay) : "0 ₽"}</b></div>
    <div class="tot"><span>Итого за ${months} мес</span><b>${fmt(down + r.total)}</b></div>`;
}
creditPrice.addEventListener("change", calcCredit);
creditDown.addEventListener("change", calcCredit);
creditTerm.addEventListener("change", calcCredit);
creditRate.addEventListener("change", calcCredit);

// --- Анимации появления при скролле ---
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

// init
renderBrandTabs();
renderFilters();
renderGrid();
calcTrade();
calcCredit();
observeReveals();
enhanceSelects();
