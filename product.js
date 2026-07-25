// Страница товара: данные из живого каталога, выбор цвета/памяти,
// рассрочка Zero, трейд-ин, корзина и кнопка «Связаться» в Telegram.

const root = document.getElementById("product");

// Выбранные пользователем опции — попадают в сообщение магазину.
const selected = { color: null, storage: null, variant: null };

function specRow(k, v) {
  return v ? `<div class="spec"><span>${k}</span><span>${v}</span></div>` : "";
}

function notFound() {
  root.innerHTML = `<div class="container empty">
    <h1>Товар не найден</h1>
    <p class="lead">Возможно, он больше не продаётся или ссылка устарела.</p>
    <a href="index.html" class="btn">← В каталог</a>
  </div>`;
}

function renderProduct(p, all) {
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

  const specs = Object.entries(p.specifications || {}).filter(([, v]) => v);

  root.innerHTML = `
  <div class="crumbs container">
    <a href="index.html">Главная</a> <span>/</span>
    <a href="index.html#catalog">Каталог</a> <span>/</span>
    <b>${p.name}</b>
  </div>

  <section class="product container">
    <div class="product__media reveal in">
      ${mediaHTML(p, "gallery")}
      ${p.images?.length > 1 ? `<div class="thumbs">${p.images.slice(0, 5).map((u, i) => `<img src="${u}" alt="" data-i="${i}" class="${i === 0 ? "active" : ""}" onerror="this.remove()">`).join("")}</div>` : ""}
    </div>

    <div class="product__info reveal in">
      ${p.badge ? `<span class="tag">${p.badge}</span>` : ""}
      ${p.available ? "" : `<span class="tag tag--out">Нет в наличии</span>`}
      <h1 class="product__name">${p.name}</h1>
      ${p.description ? `<p class="product__lead">${p.description}</p>` : ""}

      <div class="product__price">
        <b id="pPrice">${fmt(p.price, p.currency)}</b>
        <span id="pMonthly">или от ${fmt(installment(p.price, 12).monthly, p.currency)} / мес · Zero</span>
      </div>

      ${swatches
        ? `<div class="opt">
             <p class="opt__title">Цвет: <em id="colorName">${p.swatches[0][0]}</em></p>
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
        <a href="#calc" class="btn btn--ghost">Рассчитать рассрочку</a>
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

  <section class="tradeblock container" id="calc">
    <div class="tradeblock__head reveal in">
      <p class="eyebrow">Обмен + рассрочка Zero</p>
      <h2 class="section__title">Рассчитай свою цену</h2>
      <p class="lead">Сдай старый телефон в трейд-ин, а остаток оформи в рассрочку Zero: проходишь верификацию в приложении и сразу забираешь технику.</p>
    </div>
    <div class="tradeblock__grid">
      <div class="tcalc reveal in">
        <label>Твой текущий телефон
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
          <div><span>Цена ${p.name}</span><b>${fmt(p.price, p.currency)}</b></div>
          <div class="minus"><span>− Обмен твоего телефона</span><b id="tvVal">− 0</b></div>
          <div class="total"><span>Остаток</span><b id="tvPay">${fmt(p.price, p.currency)}</b></div>
        </div>
        <p class="tcalc__sub">Сумма к оплате по Zero:</p>
        <div class="terms" id="terms"></div>
        <p class="tcalc__over" id="tvOver"></p>
      </div>
      <ol class="steps reveal in">
        <li><b>1. Выбираешь товар</b><p>Открываешь карточку и добавляешь свой старый телефон для оценки.</p></li>
        <li><b>2. Оцениваем обмен</b><p>Считаем стоимость твоего телефона и вычитаем её из цены нового.</p></li>
        <li><b>3. Проходишь верификацию Zero</b><p>В приложении Zero, моментально — без справок и залога.</p></li>
        <li><b>4. Забираешь технику</b><p>Остаток делится на 3, 6 или 12 месяцев.</p></li>
      </ol>
    </div>
  </section>

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
  wireTradeIn(p);
  wireInteractions(p);
}

function renderRelated(p, all) {
  const rel = all
    .filter((x) => x.id !== p.id && x.category === p.category)
    .concat(all.filter((x) => x.id !== p.id && x.category !== p.category))
    .slice(0, 4);

  document.getElementById("related").innerHTML = rel
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
const TRADEIN = [
  ["Не сдаю телефон", 0],
  ["iPhone 15 Pro Max", 900], ["iPhone 15 Pro", 800], ["iPhone 15", 620],
  ["iPhone 14 Pro", 600], ["iPhone 14", 480], ["iPhone 13", 360], ["iPhone 12", 260],
  ["Galaxy S24 Ultra", 740], ["Galaxy S24", 520], ["Galaxy S23", 380], ["Galaxy S22", 260],
  ["Другой Android (флагман)", 180], ["Другой Android (бюджет)", 65],
];

function wireTradeIn(p) {
  const pOld = document.getElementById("pOld");
  const pCond = document.getElementById("pCond");
  pOld.innerHTML = TRADEIN.map((t, i) => `<option value="${t[1]}"${i === 0 ? " selected" : ""}>${t[0]}</option>`).join("");

  function recalc() {
    // Оценка обмена в USD — приводим к валюте товара, чтобы вычесть из цены.
    const tradeUsd = +pOld.value * +pCond.value;
    const principal = Math.max(p.price - convertPrice(tradeUsd, "USD", p.currency), 0);

    document.getElementById("tvVal").textContent = "− " + fmt(tradeUsd, "USD");
    document.getElementById("tvPay").textContent = fmt(principal, p.currency);
    document.getElementById("terms").innerHTML = ZERO_TERM_LIST.map((t) => {
      const r = installment(principal, t);
      return `<div class="term"><b>${fmt(r.monthly, p.currency)}</b><span>× ${t} мес</span><em>всего ${fmt(r.total, p.currency)}</em></div>`;
    }).join("");

    const year = installment(principal, 12);
    document.getElementById("tvOver").textContent =
      principal > 0
        ? `Переплата за 12 мес: + ${fmt(year.overpay, p.currency)} — стоимость делится на ${year.rate}`
        : "Обмен полностью покрывает стоимость 🎉";
  }

  [pOld, pCond].forEach((el) => el.addEventListener("change", recalc));
  recalc();
  onCurrencyChange(recalc);
}

function wireInteractions(p) {
  root.addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (sw) {
      root.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      selected.color = sw.dataset.name;
      const label = document.getElementById("colorName");
      if (label) label.textContent = sw.dataset.name;
    }
    const pill = e.target.closest(".pill");
    if (pill) {
      pill.parentElement.querySelectorAll(".pill").forEach((s) => s.classList.remove("active"));
      pill.classList.add("active");
      selected.storage = pill.textContent.trim();
    }
    const thumb = e.target.closest(".thumbs img");
    if (thumb) {
      const main = root.querySelector(".gallery img");
      if (main) main.src = thumb.src;
      root.querySelectorAll(".thumbs img").forEach((t) => t.classList.remove("active"));
      thumb.classList.add("active");
    }
  });

  // Заказ — в WhatsApp с готовым текстом, вопрос — в Telegram.
  document.getElementById("btnBuy").addEventListener("click", () => {
    handleOrderClick(productMessage(p, selected));
  });

  document.getElementById("btnContact").addEventListener("click", () => {
    handleTelegramClick(productMessage(p, selected));
  });

  document.getElementById("btnCart").addEventListener("click", () => {
    cartAdd(p.id, 1);
    toast("Добавлено в корзину");
  });

  onCurrencyChange(() => {
    document.getElementById("pPrice").textContent = fmt(p.price, p.currency);
    document.getElementById("pMonthly").textContent =
      `или от ${fmt(installment(p.price, 12).monthly, p.currency)} / мес · Zero`;
    renderRelated(p, CATALOG.products);
  });
}

(async function init() {
  const all = await loadCatalog();
  mountHeaderControls();
  mountCartDrawer();

  const id = new URLSearchParams(location.search).get("id");
  const product = getProduct(id);

  if (!product) notFound();
  else renderProduct(product, all);

  enhanceSelects();
  window.scrollTo(0, 0);
})();
