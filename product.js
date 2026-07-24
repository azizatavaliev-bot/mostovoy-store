const params = new URLSearchParams(location.search);
const p = getPhone(params.get("id"));
const root = document.getElementById("product");

if (!p) {
  root.innerHTML = `<div class="container empty">
    <h1>Товар не найден</h1>
    <a href="index.html" class="btn">← В каталог</a>
  </div>`;
} else {
  document.title = `МОСТОВОЙ — ${p.name}`;
  const monthly = (m) => fmt(Math.round(p.price / m));

  // Ссылки-заявки (WhatsApp, если задан номер, иначе Telegram-контакт)
  const msgBuy = `Здравствуйте! Хочу купить ${p.name} — ${fmt(p.price)}. Актуальна ли цена?`;
  const msgDel = `Здравствуйте! Хочу заказать доставку: ${p.name} — ${fmt(p.price)}.`;
  const contactUrl = (text) =>
    STORE.wa ? `https://wa.me/${STORE.wa}?text=${encodeURIComponent(text)}`
             : `https://t.me/${STORE.tg}`;

  const swatches = (p.swatches || [])
    .map((c, i) => `<button class="swatch ${i === 0 ? "active" : ""}" style="--c:${c[1]}" title="${c[0]}" data-name="${c[0]}"></button>`)
    .join("");

  const specRow = (k, v) => `<div class="spec"><span>${k}</span><span>${v}</span></div>`;

  root.innerHTML = `
  <div class="crumbs container">
    <a href="index.html">Главная</a> <span>/</span>
    <a href="index.html#catalog">Каталог</a> <span>/</span>
    <b>${p.name}</b>
  </div>

  <section class="product container">
    <div class="product__media reveal in">
      ${mediaHTML(p, "gallery")}
    </div>

    <div class="product__info reveal in">
      ${p.badge ? `<span class="tag">${p.badge}</span>` : ""}
      <h1 class="product__name">${p.name}</h1>
      <p class="product__lead">${p.desc}</p>

      <div class="product__price">
        <b>${fmt(p.price)}</b>
        <span>или от ${monthly(24)} / мес · 0%</span>
      </div>

      <div class="opt">
        <p class="opt__title">Цвет: <em id="colorName">${p.swatches ? p.swatches[0][0] : ""}</em></p>
        <div class="swatches">${swatches}</div>
      </div>

      <div class="opt">
        <p class="opt__title">Память</p>
        <div class="pills">${p.storage.split(" / ").map((s, i) => `<button class="pill ${i === 0 ? "active" : ""}">${s}</button>`).join("")}</div>
      </div>

      <div class="product__cta">
        <a href="${contactUrl(msgBuy)}" target="_blank" rel="noopener" class="btn">Купить</a>
        <a href="${contactUrl(msgDel)}" target="_blank" rel="noopener" class="btn btn--dark">Заказать доставку</a>
        <a href="#calc" class="btn btn--ghost">В рассрочку</a>
        <a href="#calc" class="btn btn--ghost">Обменять с доплатой</a>
      </div>

      <div class="product__perks">
        <div>🚚 Доставка 1–2 дня</div>
        <div>✅ Гарантия 1 год</div>
        <div>🔄 Trade-in</div>
      </div>
    </div>
  </section>

  <section class="highlights container">
    ${[
      ["📱", "Дисплей", p.display],
      ["⚡", "Процессор", p.chip],
      ["📷", "Камера", p.camera],
      ["🔋", "Батарея", p.battery],
    ].map((h) => `<div class="hl"><span class="hl__ico">${h[0]}</span><b>${h[1]}</b><p>${h[2]}</p></div>`).join("")}
  </section>

  <section class="tradeblock container" id="calc">
    <div class="tradeblock__head reveal in">
      <p class="eyebrow">Обмен + рассрочка</p>
      <h2 class="section__title">Рассчитай свою цену</h2>
      <p class="lead">Сдай старый телефон в trade-in и оформи остаток в рассрочку 0%. Смотри, как это работает.</p>
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
        <div class="tcalc__row2">
          <label>Первый взнос
            <select id="pDown">
              <option value="0">0 ₽</option>
              <option value="0.1">10%</option>
              <option value="0.2">20%</option>
              <option value="0.3">30%</option>
            </select>
          </label>
          <label>Ставка
            <select id="pRate">
              <option value="0">0% — промо</option>
              <option value="12">12% годовых</option>
              <option value="18">18% годовых</option>
            </select>
          </label>
        </div>
        <div class="tcalc__rows">
          <div><span>Цена ${p.name}</span><b>${fmt(p.price)}</b></div>
          <div class="minus"><span>− Обмен твоего телефона</span><b id="tvVal">− 0 ₽</b></div>
          <div class="minus"><span>− Первый взнос</span><b id="tvDown">− 0 ₽</b></div>
          <div class="total"><span>Сумма рассрочки</span><b id="tvPay">${fmt(p.price)}</b></div>
        </div>
        <p class="tcalc__sub">Платёж в месяц:</p>
        <div class="terms" id="terms"></div>
        <p class="tcalc__over" id="tvOver"></p>
      </div>
      <ol class="steps reveal in">
        <li><b>1. Выбираешь модель</b><p>Открываешь товар и добавляешь свой старый телефон для оценки.</p></li>
        <li><b>2. Оцениваем обмен</b><p>Считаем стоимость твоего телефона и вычитаем её из цены нового.</p></li>
        <li><b>3. Платишь остаток частями</b><p>Оставшуюся сумму делим на 6, 12 или 24 месяца — без переплат.</p></li>
        <li><b>4. Забираешь новый</b><p>Приносишь старый, доплачиваешь первый платёж — и телефон твой.</p></li>
      </ol>
    </div>
  </section>

  <section class="specs-full container">
    <h2 class="section__title">Характеристики</h2>
    <div class="spec-table">
      ${specRow("Дисплей", p.display)}
      ${specRow("Процессор", p.chip)}
      ${specRow("Основная камера", p.camera)}
      ${specRow("Фронтальная камера", p.front)}
      ${specRow("Батарея", p.battery)}
      ${specRow("Корпус", p.material)}
      ${specRow("Защита", p.water)}
      ${specRow("Разъём", p.connector)}
      ${specRow("Память", p.storage)}
      ${specRow("Вес", p.weight)}
      ${specRow("ОС", p.os)}
      ${specRow("Цвета", p.colors)}
    </div>
  </section>

  <section class="related container">
    <h2 class="section__title">Похожие модели</h2>
    <div class="grid" id="related"></div>
  </section>`;

  // похожие — из того же поколения, иначе ближайшие
  const rel = PHONES.filter((x) => x.id !== p.id && x.gen === p.gen)
    .concat(PHONES.filter((x) => x.id !== p.id && x.gen !== p.gen))
    .slice(0, 4);
  document.getElementById("related").innerHTML = rel
    .map(
      (r) => `<a class="card" href="product.html?id=${r.id}">
        ${r.badge ? `<span class="card__badge">${r.badge}</span>` : `<span class="card__badge" style="visibility:hidden">·</span>`}
        ${mediaHTML(r, "card__media")}
        <h3 class="card__name">${r.name}</h3>
        <p class="card__spec">${r.display.split("″")[0]}″ · ${r.chip}</p>
        <div class="card__price">${fmt(r.price)}</div>
      </a>`
    )
    .join("");
  // показать карточки (у .card по умолчанию opacity:0 из-за анимации)
  document.querySelectorAll("#related .card").forEach((c) => c.classList.add("in"));

  // --- Трейд-ин + рассрочка ---
  const TRADEIN = [
    ["Не сдаю телефон", 0],
    ["iPhone 15 Pro Max", 95000], ["iPhone 15 Pro", 85000], ["iPhone 15", 65000],
    ["iPhone 14 Pro", 62000], ["iPhone 14", 50000], ["iPhone 13", 38000], ["iPhone 12", 28000],
    ["Galaxy S24 Ultra", 78000], ["Galaxy S24", 55000], ["Galaxy S23", 40000], ["Galaxy S22", 28000],
    ["Другой Android (флагман)", 20000], ["Другой Android (бюджет)", 7000],
  ];
  const TERMS = [6, 12, 24];
  const pOld = document.getElementById("pOld");
  const pCond = document.getElementById("pCond");
  const pDown = document.getElementById("pDown");
  const pRate = document.getElementById("pRate");
  pOld.innerHTML = TRADEIN.map((t, i) => `<option value="${t[1]}"${i === 0 ? " selected" : ""}>${t[0]}</option>`).join("");

  function recalcTrade() {
    const tv = Math.round(+pOld.value * +pCond.value);
    const afterTrade = Math.max(p.price - tv, 0);
    const down = Math.round(afterTrade * +pDown.value);
    const principal = Math.max(afterTrade - down, 0);
    const rate = +pRate.value;
    document.getElementById("tvVal").textContent = "− " + fmt(tv);
    document.getElementById("tvDown").textContent = "− " + fmt(down);
    document.getElementById("tvPay").textContent = fmt(principal);
    document.getElementById("terms").innerHTML = TERMS.map((t) => {
      const r = installment(principal, t, rate);
      return `<div class="term"><b>${fmt(r.monthly)}</b><span>× ${t} мес</span></div>`;
    }).join("");
    const y = installment(principal, 12, rate);
    document.getElementById("tvOver").textContent =
      rate === 0 ? "Ставка 0% — без переплат 🎉" : `Переплата за 12 мес: + ${fmt(y.overpay)}`;
  }
  [pOld, pCond, pDown, pRate].forEach((el) => el.addEventListener("change", recalcTrade));
  recalcTrade();

  // интерактив: цвет и память
  root.addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (sw) {
      root.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      document.getElementById("colorName").textContent = sw.dataset.name;
    }
    const pill = e.target.closest(".pill");
    if (pill) {
      pill.parentElement.querySelectorAll(".pill").forEach((s) => s.classList.remove("active"));
      pill.classList.add("active");
    }
  });

  enhanceSelects();
  window.scrollTo(0, 0);
}
