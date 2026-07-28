// Страница товара: данные из живого каталога, выбор цвета/памяти,
// рассрочка, трейд-ин, корзина и кнопка «Связаться» в Telegram.
import "./styles.css";
import "./page-loader";
import {
  CATALOG,
  cartAdd,
  convertPrice,
  fmt,
  getProduct,
  handleOrderClick,
  handleTelegramClick,
  loadCatalog,
  mountCartDrawer,
  mountHeaderControls,
  mountWhatsappFloat,
  onCurrencyChange,
  productMessage,
  toast,
} from "./catalog";
import { enhanceSelects, installment, INSTALLMENT_TERM_LIST, isInstallmentEligible, mediaHTML } from "./render";
import type { Product } from "./types";

const root = document.getElementById("product") as HTMLElement;

// Выбранные пользователем опции — попадают в сообщение магазину.
const selected: { color: string | null; storage: string | null; variant: string | null } = {
  color: null,
  storage: null,
  variant: null,
};

function specRow(k: string, v: string | undefined): string {
  return v ? `<div class="spec"><span>${k}</span><span>${v}</span></div>` : "";
}

// Объём памяти в ГБ из строки вида «256 ГБ» / «1 ТБ» / «512GB».
function storageGB(str: string | null | undefined): number | null {
  const m = String(str || "")
    .toUpperCase()
    .match(/([\d.]+)\s*(TB|ТБ|GB|ГБ)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /TB|ТБ/.test(m[2]) ? n * 1024 : n;
}

// Цена товара зависит от выбранной памяти: у p.price — цена младшего варианта
// (storageOptions[0]), у остальных — наценка. В реальных прайсах Apple/Samsung
// удвоение объёма стоит дороже не в 2 раза, а примерно на 15–20%, поэтому берём
// степенную зависимость (ratio ** 0.25), а не линейную или пропорциональную.
function priceForStorage(basePrice: number, storageOptions: string[], selectedStorage: string | null): number {
  if (!storageOptions?.length || !selectedStorage) return basePrice;
  const baseGB = storageGB(storageOptions[0]);
  const selGB = storageGB(selectedStorage);
  if (!baseGB || !selGB || baseGB === selGB) return basePrice;
  return Math.round(basePrice * Math.pow(selGB / baseGB, 0.25));
}

function notFound(): void {
  root.innerHTML = `<div class="container empty">
    <h1>Товар не найден</h1>
    <p class="lead">Возможно, он больше не продаётся или ссылка устарела.</p>
    <a href="index.html" class="btn">← В каталог</a>
  </div>`;
}

interface PriceState {
  value: number;
}

function renderProduct(p: Product, all: Product[]): void {
  document.title = `МОСТОВОЙ — ${p.name}`;
  selected.color = p.color || null;
  selected.storage = p.storage || null;
  selected.variant = p.variant || null;

  // Свотчи есть только у легаси-телефонов; у товаров из Telegram — цвет строкой.
  const swatches = (p.swatches || [])
    .map((c, i) => `<button class="swatch ${i === 0 ? "active" : ""}" style="--c:${c[1]}" title="${c[0]}" data-name="${c[0]}"></button>`)
    .join("");

  // Варианты памяти: «128 ГБ / 256 ГБ» из легаси или одно значение из базы.
  const storageOptions = p.specifications?.Память
    ? String(p.specifications.Память).split(" / ")
    : p.storage
      ? [p.storage]
      : [];

  // По умолчанию выбран первый вариант памяти — он же активная «пилюля».
  if (storageOptions.length) selected.storage = storageOptions[0].trim();

  // Текущая цена с учётом выбранной памяти. p.price всегда остаётся ценой
  // младшего варианта — от неё считается наценка при переключении пилюль.
  const priceState: PriceState = { value: p.price };
  const installmentEligible = isInstallmentEligible(p);

  const specs = Object.entries(p.specifications || {}).filter(([, v]) => v) as [string, string][];

  root.innerHTML = `
  <div class="crumbs container">
    <a href="index.html">Главная</a> <span>/</span>
    <a href="index.html#catalog">Каталог</a> <span>/</span>
    <b>${p.name}</b>
  </div>

  <section class="product container">
    <div class="product__media reveal in">
      ${mediaHTML(p, "gallery")}
      ${p.images?.length && p.images.length > 1 ? `<div class="thumbs">${p.images.slice(0, 5).map((u, i) => `<img src="${u}" alt="" data-i="${i}" class="${i === 0 ? "active" : ""}" onerror="this.remove()">`).join("")}</div>` : ""}
    </div>

    <div class="product__info reveal in">
      ${p.badge ? `<span class="tag">${p.badge}</span>` : ""}
      ${p.available ? "" : `<span class="tag tag--out">Нет в наличии</span>`}
      <h1 class="product__name">${p.name}</h1>
      ${p.description ? `<p class="product__lead">${p.description}</p>` : ""}

      <div class="product__price">
        <b id="pPrice">${fmt(p.price, p.currency)}</b>
        ${installmentEligible ? `<span id="pMonthly">или от ${fmt(installment(p.price, 12).monthly, p.currency)} / мес</span>` : ""}
      </div>

      ${swatches
        ? `<div class="opt">
             <p class="opt__title">Цвет: <em id="colorName">${(p.swatches as NonNullable<Product["swatches"]>)[0][0]}</em></p>
             <div class="swatches">${swatches}</div>
           </div>`
        : p.color
          ? `<div class="opt"><p class="opt__title">Цвет: <em>${p.color}</em></p></div>`
          : ""}

      ${storageOptions.length
        ? `<div class="opt">
             <p class="opt__title">Память</p>
             <div class="pills">${storageOptions.map((s, i) => `<button class="pill ${i === 0 ? "active" : ""}">${s.trim()}</button>`).join("")}</div>
           </div>`
        : ""}

      <div class="product__cta">
        <button type="button" class="btn" id="btnBuy">Купить в WhatsApp</button>
        <button type="button" class="btn btn--dark" id="btnCart">В корзину</button>
        <button type="button" class="btn btn--ghost" id="btnContact">Связаться в Telegram</button>
        ${installmentEligible ? `<a href="#calc" class="btn btn--ghost">Рассчитать рассрочку</a>` : ""}
      </div>

      <div class="product__perks">
        <div>🚚 Доставка 1–2 дня</div>
        <div>✅ Гарантия 1 год</div>
        <div>🔄 Trade-in</div>
      </div>
      ${p.needsResearch ? `<p class="note">Описание и фото уточняются. Цена и наличие актуальны.</p>` : ""}
      ${p.sourcePage ? `<p class="note">Характеристики по данным <a href="${p.sourcePage}" target="_blank" rel="noopener nofollow">официального источника</a>.</p>` : ""}
    </div>
  </section>

  ${installmentEligible ? `<section class="tradeblock container" id="calc">
    <div class="tradeblock__head reveal in">
      <p class="eyebrow">Обмен + рассрочка</p>
      <h2 class="section__title">Рассчитай свою цену</h2>
      <p class="lead">Сдай старый телефон или MacBook в трейд-ин, а остаток раздели на удобный срок.</p>
    </div>
    <div class="tradeblock__grid">
      <div class="tcalc reveal in">
        <label>Твоё текущее устройство
          <select id="pOld"></select>
        </label>
        <label>Состояние
          <select id="pCond">
            <option value="1">Отличное</option>
            <option value="0.7" selected>Хорошее</option>
            <option value="0.45">С дефектами</option>
          </select>
        </label>
        <div class="tcalc__rows">
          <div><span>Цена ${p.name}</span><b id="tcBasePrice">${fmt(priceState.value, p.currency)}</b></div>
          <div class="minus"><span>− Обмен твоего устройства</span><b id="tvVal">− 0</b></div>
          <div class="total"><span>Остаток</span><b id="tvPay">${fmt(priceState.value, p.currency)}</b></div>
        </div>
        <p class="tcalc__sub">Сумма к оплате:</p>
        <div class="terms" id="terms"></div>
        <p class="tcalc__over" id="tvOver"></p>
      </div>
      <ol class="steps reveal in">
        <li><b>1. Выбираешь товар</b><p>Открываешь карточку и добавляешь своё старое устройство для оценки.</p></li>
        <li><b>2. Оцениваем обмен</b><p>Считаем стоимость устройства и вычитаем её из цены нового.</p></li>
        <li><b>3. Выбираешь срок</b><p>Сразу видишь ежемесячный платёж и итоговую сумму.</p></li>
        <li><b>4. Забираешь технику</b><p>Остаток делится на 3, 6 или 12 месяцев.</p></li>
      </ol>
    </div>
  </section>` : ""}

  ${specs.length
    ? `<section class="specs-full container">
         <h2 class="section__title">Характеристики</h2>
         <div class="spec-table">${specs.map(([k, v]) => specRow(k, v)).join("")}</div>
       </section>`
    : ""}

  <section class="related container">
    <h2 class="section__title">Похожие товары</h2>
    <div class="grid" id="related"></div>
  </section>`;

  renderRelated(p, all);
  const tradeRecalc = installmentEligible ? wireTradeIn(p, priceState) : () => {};
  wireInteractions(p, priceState, tradeRecalc);
}

function renderRelated(p: Product, all: Product[]): void {
  const rel = all
    .filter((x) => x.id !== p.id && x.category === p.category)
    .concat(all.filter((x) => x.id !== p.id && x.category !== p.category))
    .slice(0, 4);

  document.getElementById("related")!.innerHTML = rel
    .map(
      (r) => `<article class="card in">
        <a class="card__link" href="product.html?id=${encodeURIComponent(r.id)}">
          ${r.badge ? `<span class="card__badge">${r.badge}</span>` : `<span class="card__badge" style="visibility:hidden">·</span>`}
          ${mediaHTML(r, "card__media")}
          <h3 class="card__name">${r.name}</h3>
          <p class="card__spec">${r.category || ""}</p>
          <div class="card__price">${fmt(r.price, r.currency)}</div>
        </a>
      </article>`
    )
    .join("");
}

// Оценки трейд-ина заданы в долларах.
const TRADEIN: [string, number][] = [
  ["Не сдаю устройство", 0],
  ["iPhone 15 Pro Max", 900], ["iPhone 15 Pro", 800], ["iPhone 15", 620],
  ["iPhone 14 Pro", 600], ["iPhone 14", 480], ["iPhone 13", 360], ["iPhone 12", 260],
  ["Galaxy S24 Ultra", 740], ["Galaxy S24", 520], ["Galaxy S23", 380], ["Galaxy S22", 260],
  ["Другой Android (флагман)", 180], ["Другой Android (бюджет)", 65],
  ["MacBook Air M1", 450], ["MacBook Air M2", 650], ["MacBook Air M3 / M4", 850],
  ["MacBook Pro 14", 1050], ["MacBook Pro 16", 1250],
];

function wireTradeIn(p: Product, priceState: PriceState): () => void {
  const pOld = document.getElementById("pOld") as HTMLSelectElement;
  const pCond = document.getElementById("pCond") as HTMLSelectElement;
  pOld.innerHTML = TRADEIN.map((t, i) => `<option value="${t[1]}"${i === 0 ? " selected" : ""}>${t[0]}</option>`).join("");

  function recalc() {
    document.getElementById("tcBasePrice")!.textContent = fmt(priceState.value, p.currency);

    // Оценка обмена в USD — приводим к валюте товара, чтобы вычесть из цены.
    const tradeUsd = +pOld.value * +pCond.value;
    const principal = Math.max(priceState.value - (convertPrice(tradeUsd, "USD", p.currency) || 0), 0);

    document.getElementById("tvVal")!.textContent = "− " + fmt(tradeUsd, "USD");
    document.getElementById("tvPay")!.textContent = fmt(principal, p.currency);
    document.getElementById("terms")!.innerHTML = INSTALLMENT_TERM_LIST.map((t) => {
      const r = installment(principal, t);
      return `<div class="term"><b>${fmt(r.monthly, p.currency)}</b><span>× ${t} мес</span><em>всего ${fmt(r.total, p.currency)}</em></div>`;
    }).join("");

    const year = installment(principal, 12);
    document.getElementById("tvOver")!.textContent =
      principal > 0
        ? `Переплата за 12 мес: + ${fmt(year.overpay, p.currency)} — стоимость делится на ${year.rate}`
        : "Обмен полностью покрывает стоимость 🎉";
  }

  [pOld, pCond].forEach((el) => el.addEventListener("change", recalc));
  recalc();
  onCurrencyChange(recalc);
  return recalc;
}

function wireInteractions(p: Product, priceState: PriceState, tradeRecalc: () => void): void {
  // Варианты памяти для расчёта наценки — те же, что показаны пилюлями.
  const storageOptions = p.specifications?.Память
    ? String(p.specifications.Память).split(" / ").map((s) => s.trim())
    : p.storage
      ? [p.storage]
      : [];

  function refreshPrice() {
    document.getElementById("pPrice")!.textContent = fmt(priceState.value, p.currency);
    const monthly = document.getElementById("pMonthly");
    if (monthly) {
      monthly.textContent = `или от ${fmt(installment(priceState.value, 12).monthly, p.currency)} / мес`;
    }
    tradeRecalc();
  }

  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const sw = target.closest<HTMLElement>(".swatch");
    if (sw) {
      root.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      selected.color = sw.dataset.name as string;
      const label = document.getElementById("colorName");
      if (label) label.textContent = sw.dataset.name as string;
    }
    const pill = target.closest<HTMLElement>(".pill");
    if (pill) {
      pill.parentElement!.querySelectorAll(".pill").forEach((s) => s.classList.remove("active"));
      pill.classList.add("active");
      selected.storage = (pill.textContent || "").trim();
      priceState.value = priceForStorage(p.price, storageOptions, selected.storage);
      refreshPrice();
    }
    const thumb = target.closest<HTMLImageElement>(".thumbs img");
    if (thumb) {
      const main = root.querySelector<HTMLImageElement>(".gallery img");
      if (main) main.src = thumb.src;
      root.querySelectorAll(".thumbs img").forEach((t) => t.classList.remove("active"));
      thumb.classList.add("active");
    }
  });

  // Заказ — в WhatsApp с готовым текстом, вопрос — в Telegram.
  // Цена в сообщении — с учётом выбранной памяти (priceState.value).
  document.getElementById("btnBuy")!.addEventListener("click", () => {
    handleOrderClick(
      productMessage({ ...p, price: priceState.value }, selected),
      [{ productId: p.id, quantity: 1 }],
      "product"
    );
  });

  document.getElementById("btnContact")!.addEventListener("click", () => {
    handleTelegramClick(productMessage({ ...p, price: priceState.value }, selected));
  });

  document.getElementById("btnCart")!.addEventListener("click", () => {
    cartAdd(p.id, 1);
    toast("Добавлено в корзину");
  });

  onCurrencyChange(() => {
    refreshPrice();
    renderRelated(p, CATALOG.products);
  });
}

(async function init() {
  const all = await loadCatalog();
  mountHeaderControls();
  mountCartDrawer();
  mountWhatsappFloat();

  const id = new URLSearchParams(location.search).get("id");
  const product = id ? getProduct(id) : null;

  if (!product) notFound();
  else renderProduct(product, all);

  enhanceSelects();
  window.scrollTo(0, 0);
})();
