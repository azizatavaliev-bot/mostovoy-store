// Рендер телефона: реалистичный SVG «вид сзади» по данным модели.
// Если есть фото images/{id}.jpg — оно перекрывает SVG.

function darken(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  const r = cl((n >> 16) - amt), g = cl(((n >> 8) & 255) - amt), b = cl((n & 255) - amt);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function lensSVG(cx, cy, r) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0b0d"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="#20222a"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.34}" fill="#0c0d12"/>
    <circle cx="${cx - r * 0.28}" cy="${cy - r * 0.28}" r="${r * 0.16}" fill="#4a5568"/>`;
}

function cameraModule(p) {
  // Samsung: отдельные линзы вертикально слева (без модуля).
  if (p.style === "samsung") {
    const n = p.lenses;
    let out = "";
    for (let i = 0; i < n; i++) {
      out += lensSVG(62, 46 + i * (n >= 4 ? 40 : 48), i < 2 ? 13 : 10);
    }
    out += `<circle cx="92" cy="48" r="4" fill="#e6e6ea"/><rect x="86" y="60" width="12" height="20" rx="6" fill="rgba(0,0,0,.12)"/>`;
    return out;
  }
  // Apple: модуль камеры сверху-слева. Pro (3 линзы) — квадратный блок, обычный (2) — компактный, SE (1) — одиночная.
  if (p.lenses >= 3) {
    return `<rect x="42" y="30" width="70" height="70" rx="22" fill="rgba(0,0,0,.16)" stroke="rgba(0,0,0,.22)"/>
      ${lensSVG(62, 50, 12)}${lensSVG(62, 80, 12)}${lensSVG(92, 65, 12)}
      <circle cx="96" cy="42" r="4.5" fill="#e6e6ea"/>
      <rect x="90" y="80" width="10" height="10" rx="3" fill="#1a1a1f"/>`;
  }
  if (p.lenses === 2) {
    return `<rect x="42" y="30" width="58" height="58" rx="20" fill="rgba(0,0,0,.14)" stroke="rgba(0,0,0,.2)"/>
      ${lensSVG(60, 48, 12)}${lensSVG(84, 72, 12)}
      <circle cx="84" cy="46" r="4" fill="#e6e6ea"/>`;
  }
  return `${lensSVG(72, 56, 13)}<circle cx="98" cy="50" r="4" fill="#e6e6ea"/>`;
}

function phoneSVG(p) {
  const light = darken(p.tone, -14), mid = p.tone, dark = darken(p.tone, 30);
  return `<svg viewBox="0 0 200 410" class="psvg" role="img" aria-label="${p.name}">
    <defs>
      <linearGradient id="body-${p.id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${light}"/>
        <stop offset=".5" stop-color="${mid}"/>
        <stop offset="1" stop-color="${dark}"/>
      </linearGradient>
      <linearGradient id="gloss-${p.id}" x1="0" y1="0" x2="1" y2=".8">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/>
        <stop offset=".1" stop-color="#fff" stop-opacity=".28"/>
        <stop offset=".22" stop-color="#fff" stop-opacity="0"/>
        <stop offset=".85" stop-color="#fff" stop-opacity="0"/>
        <stop offset="1" stop-color="#fff" stop-opacity=".06"/>
      </linearGradient>
      <radialGradient id="floor-${p.id}" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="#000" stop-opacity=".22"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="100" cy="398" rx="60" ry="11" fill="url(#floor-${p.id})"/>
    <rect x="30" y="6" width="140" height="384" rx="46" fill="url(#body-${p.id})" stroke="${darken(p.tone, 40)}" stroke-width="1.2"/>
    <rect x="34" y="10" width="132" height="376" rx="42" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
    ${cameraModule(p)}
    <circle cx="100" cy="210" r="16" fill="rgba(255,255,255,.09)"/>
    <circle cx="100" cy="210" r="16" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
    <rect x="30" y="6" width="140" height="384" rx="46" fill="url(#gloss-${p.id})" pointer-events="none"/>
  </svg>`;
}

// Заглушка для товаров не-телефонов (приставки, микрофоны, книги…),
// а также когда внешнее фото перестало открываться.
function placeholderSVG(p) {
  const letter = String(p.name || "?").trim().charAt(0).toUpperCase();
  return `<svg viewBox="0 0 200 200" class="psvg psvg--ph" role="img" aria-label="${p.name || ""}">
    <rect x="12" y="12" width="176" height="176" rx="28" fill="#f2f2f4" stroke="#e6e6ea"/>
    <text x="100" y="100" text-anchor="middle" dominant-baseline="central"
      font-family="Montserrat, sans-serif" font-size="64" font-weight="800" fill="#c9c9d0">${letter}</text>
  </svg>`;
}

// Обёртка: подложка (SVG-рендер телефона или заглушка) + фото поверх.
// Фото берём из p.image (каталог из базы) или p.img/PHOTOS/images (легаси).
// Если картинка не загрузилась — она удаляется и остаётся подложка.
function mediaHTML(p, cls) {
  const fromFeed = typeof window !== "undefined" && window.PHOTOS && window.PHOTOS[p.id];
  const src = p.image || p.img || fromFeed || (p.id ? `images/${p.id}.jpg` : "");
  // tone/lenses есть только у телефонов из data.js — по ним и выбираем рендер.
  const base = p.tone ? phoneSVG(p) : placeholderSVG(p);
  const img = src
    ? `<img src="${src}" alt="${p.name}" loading="lazy"
        onload="this.previousElementSibling.style.opacity='0'"
        onerror="this.remove()">`
    : "";
  return `<div class="${cls}">${base}${img}</div>`;
}

// Рассрочка Zero (онлайн-приложение).
// Прошёл верификацию — сразу берёшь технику в рассрочку.
// Сумма к оплате = стоимость / коэффициент срока. Коэффициент задаёт переплату.
//   3 мес  → / 0.94   (40000 / 0.94 = 42 553,19)
//   6 мес  → / 0.89   (40000 / 0.89 = 44 943,82)
//   12 мес → / 0.84   (40000 / 0.84 = 47 619,05)
const ZERO_TERMS = { 3: 0.94, 6: 0.89, 12: 0.84 };
const ZERO_TERM_LIST = [3, 6, 12];

function installment(principal, months) {
  principal = Math.max(principal, 0);
  const k = ZERO_TERMS[months];
  if (!k) return { monthly: 0, total: 0, overpay: 0, rate: null };
  const total = principal / k;
  return {
    monthly: total / months,
    total,
    overpay: Math.max(total - principal, 0),
    rate: k,
  };
}

// --- Кастомные дропдауны (замена системных <select>) ---
function enhanceSelect(sel) {
  if (sel.dataset.cs) return;
  sel.dataset.cs = "1";
  const wrap = document.createElement("div");
  wrap.className = "cselect";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cselect__btn";
  const menu = document.createElement("div");
  menu.className = "cselect__menu";
  wrap.appendChild(btn);
  wrap.appendChild(menu);

  function build() {
    menu.innerHTML = "";
    [...sel.options].forEach((o, i) => {
      const it = document.createElement("div");
      it.className = "cselect__opt";
      it.innerHTML = `<span>${o.textContent}</span><i class="cselect__tick"></i>`;
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        update();
        wrap.classList.remove("open");
      });
      menu.appendChild(it);
    });
  }
  function update() {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span>${o ? o.textContent : ""}</span><i class="cselect__chev"></i>`;
    [...menu.children].forEach((c, i) => c.classList.toggle("sel", i === sel.selectedIndex));
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("open");
    document.querySelectorAll(".cselect.open").forEach((w) => w.classList.remove("open"));
    if (!wasOpen) wrap.classList.add("open");
  });
  build();
  update();
  sel._cs = { build, update };
}
function enhanceSelects(root = document) {
  root.querySelectorAll("select").forEach(enhanceSelect);
}
document.addEventListener("click", () =>
  document.querySelectorAll(".cselect.open").forEach((w) => w.classList.remove("open"))
);

// --- Общее поведение шапки: бургер-меню + тень при скролле ---
document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector(".header");
  const burger = document.getElementById("burger");
  const nav = document.getElementById("nav");
  if (burger && nav) {
    burger.addEventListener("click", () => {
      nav.classList.toggle("open");
      burger.classList.toggle("active");
    });
    nav.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        nav.classList.remove("open");
        burger.classList.remove("active");
      })
    );
  }
  const onScroll = () => header && header.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
});
