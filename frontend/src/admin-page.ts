// Админка: вход по логину/паролю (сессия — httpOnly cookie, ставит и проверяет
// сервер), товары (фото по URL или загрузкой, описание, цена, диапазон
// памяти, доступные цвета, акции), новости, журнал изменения цен.
//
// Всё ходит в /api/admin/* — тот же API, что доступен из терминала
// (npm run admin, по ADMIN_TOKEN) и curl'ом напрямую.
import "./styles.css";

type Swatch = [string, string];
type ProductStatus = "active" | "needs_research" | "hidden" | "sync_error";

interface AdminProduct {
  slug: string;
  name: string;
  brand?: string;
  category?: string;
  group?: string;
  price: number;
  currency: string;
  color?: string;
  variant?: string;
  storageOptions?: string[];
  description?: string;
  image?: string;
  images?: string[];
  available: boolean;
  status: ProductStatus;
  updatedAt: string;
  swatches?: Swatch[];
  discountPercent?: number | null;
  discountLabel?: string | null;
  salePrice?: number | null;
}

interface Post {
  slug: string;
  title: string;
  body?: string;
  image?: string;
  status: "published" | "draft";
  publishedAt?: string;
}

interface PriceChange {
  changedAt: string;
  productSlug?: string;
  productName: string;
  oldPrice: number | null;
  newPrice: number;
  currency: string;
  source: "telegram" | "admin";
}

interface ProductForm {
  name: string;
  brand: string;
  category: string;
  productGroup: string;
  price: number | string;
  currency: string;
  color: string;
  variant: string;
  storage: string;
  description: string;
  image: string;
  images: string;
  available: boolean;
  discountPercent: number | string;
  discountLabel: string;
}

type AdminView = "products" | "news" | "history";
type ProductSort = "updated_desc" | "group" | "brand" | "price_asc" | "price_desc" | "status";

const root = document.getElementById("admin") as HTMLElement;
const btnLogout = document.getElementById("btnLogout") as HTMLButtonElement;

const state = {
  authenticated: false,
  loginEnabled: true,
  view: "products" as AdminView,
  products: [] as AdminProduct[],
  groups: ["Гаджеты", "Игры", "Аксессуары", "Другое"],
  categorySuggestions: [] as string[],
  posts: [] as Post[],
  history: [] as PriceChange[],
  editingProductSlug: null as string | null,
  editingPostSlug: null as string | null,
  search: "",
  sortBy: "updated_desc" as ProductSort,
  loginError: null as string | null,
};

class ApiError extends Error {
  data: unknown;
}

// --- API-клиент: сессия идёт cookie'ой автоматически, credentials обязателен
// на случай, если сайт открыт не с того же origin, что API. -----------------

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: "same-origin",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    state.authenticated = false;
    renderView();
    throw new Error("Сессия истекла, войдите снова");
  }
  if (!res.ok) {
    const err = new ApiError(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data as T;
}

// --- Утилиты ---------------------------------------------------------------

function fmtMoney(n: number | null | undefined, currency: string): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("ru-RU") + " " + currency;
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `${diffD} дн назад`;
  return new Date(then).toLocaleDateString("ru-RU");
}

function esc(s: unknown): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(msg: string, ok = true): void {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("toast--error", !ok);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("show"), 3200);
}

// --- Вход по логину и паролю ------------------------------------------

async function checkSession(): Promise<void> {
  try {
    const data = await fetch("/api/admin/session", { credentials: "same-origin" }).then((r) => r.json());
    state.authenticated = data.authenticated;
    state.loginEnabled = data.loginEnabled;
  } catch {
    state.authenticated = false;
  }
}

function renderLogin(): void {
  btnLogout.hidden = true;
  if (!state.loginEnabled) {
    root.innerHTML = `<div class="admin__login">
      <h1 class="section__title">Админка</h1>
      <p class="lead">Вход по паролю не настроен на сервере. Задайте ADMIN_USERNAME, ADMIN_PASSWORD_HASH и SESSION_SECRET
      (командой <code>npm run admin:set-password</code>) — либо пользуйтесь <code>npm run admin</code> с терминала.</p>
    </div>`;
    return;
  }

  root.innerHTML = `
    <div class="admin__login">
      <div class="admin__login-brand">
        <span class="logo__badge admin__login-badge" role="img" aria-label="Мостовой"></span>
        <span class="admin__login-kicker">Панель управления</span>
      </div>
      <h1 class="section__title">С возвращением</h1>
      <p class="admin__login-copy">Войдите, чтобы управлять товарами, ценами и новостями магазина.</p>
      ${state.loginError ? `<p class="admin__error">${esc(state.loginError)}</p>` : ""}
      <form id="loginForm" class="admin__login-form">
        <label>Логин
          <input type="text" name="username" autocomplete="username" placeholder="Введите логин" required autofocus />
        </label>
        <label>Пароль
          <input type="password" name="password" autocomplete="current-password" placeholder="Введите пароль" required />
        </label>
        <button type="submit" class="btn">Войти</button>
      </form>
      <a class="admin__login-back" href="index.html">← Вернуться в магазин</a>
    </div>`;

  document.getElementById("loginForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: fd.get("username"), password: fd.get("password") }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      state.authenticated = true;
      state.loginError = null;
      renderView();
    } else {
      state.loginError = res.status === 429 ? `${data.error} (~${Math.ceil((data.retryAfterSec || 0) / 60)} мин)` : data.error || "Ошибка входа";
      renderLogin();
    }
  });
}

// --- Виджет фото: URL или загрузка файлом ----------------------------------

function imageFieldHTML(name: string, value: string | undefined, label: string): string {
  return `
    <div class="admin__imgfield" data-field="${name}">
      <p class="opt__title">${label}</p>
      <div class="admin__imgrow">
        <input type="text" name="${name}" value="${esc(value || "")}" placeholder="https://... или загрузите файл" />
        <label class="admin__uploadbtn">
          Файл…
          <input type="file" accept="image/*" hidden data-upload-for="${name}" />
        </label>
      </div>
      <div class="admin__imgpreview" data-preview-for="${name}">${value ? `<img src="${esc(value)}" alt="" onerror="this.parentElement.innerHTML=''">` : ""}</div>
    </div>`;
}

function wireImageField(formEl: HTMLFormElement, name: string): void {
  const input = formEl.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const fileInput = formEl.querySelector<HTMLInputElement>(`[data-upload-for="${name}"]`)!;
  const preview = formEl.querySelector<HTMLElement>(`[data-preview-for="${name}"]`)!;

  const showPreview = (url: string) => {
    preview.innerHTML = url ? `<img src="${esc(url)}" alt="" onerror="this.parentElement.innerHTML=''">` : "";
  };
  input.addEventListener("input", () => showPreview(input.value));

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      toast("Загружаю фото…");
      const res = await api<{ url: string }>("POST", "/upload", fd);
      input.value = res.url;
      showPreview(res.url);
      toast("Фото загружено");
    } catch (err) {
      toast((err as Error).message, false);
    } finally {
      fileInput.value = "";
    }
  });
}

// --- Виджет доступных цветов ------------------------------------------------

function swatchRowHTML(name = "", hex = "#cccccc"): string {
  return `<div class="admin__swrow">
    <input type="text" class="sw-name" placeholder="Название (Чёрный)" value="${esc(name)}" />
    <input type="color" class="sw-hex" value="${/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#cccccc"}" />
    <button type="button" class="admin__link admin__link--danger sw-remove">Удалить</button>
  </div>`;
}

function wireSwatches(formEl: HTMLFormElement, initial: Swatch[] | undefined): void {
  const wrap = formEl.querySelector(".admin__swatches")!;
  const add = formEl.querySelector(".admin__sw-add")!;
  const addRow = (name?: string, hex?: string) => wrap.insertAdjacentHTML("beforeend", swatchRowHTML(name, hex));
  (initial?.length ? initial : []).forEach(([n, h]) => addRow(n, h));

  wrap.addEventListener("click", (e) => {
    (e.target as HTMLElement).closest(".sw-remove")?.closest(".admin__swrow")?.remove();
  });
  add.addEventListener("click", () => addRow());
}

function readSwatches(formEl: HTMLFormElement): Swatch[] {
  return [...formEl.querySelectorAll<HTMLElement>(".admin__swrow")]
    .map((row): Swatch => [
      row.querySelector<HTMLInputElement>(".sw-name")!.value.trim(),
      row.querySelector<HTMLInputElement>(".sw-hex")!.value,
    ])
    .filter(([name]) => name);
}

// --- Вкладка «Товары» -------------------------------------------------------

function emptyProductForm(): ProductForm {
  return { name: "", brand: "", category: "", productGroup: "", price: "", currency: "USD", color: "", variant: "", storage: "", description: "", image: "", images: "", available: true, discountPercent: "", discountLabel: "" };
}

function productToForm(p: AdminProduct): ProductForm {
  return {
    name: p.name || "", brand: p.brand || "", category: p.category || "", productGroup: p.group || "",
    price: p.price ?? "", currency: p.currency || "USD", color: p.color || "", variant: p.variant || "",
    storage: (p.storageOptions || []).join(", "), description: p.description || "",
    image: p.image || "", images: (p.images || []).join("\n"), available: p.available !== false,
    discountPercent: p.discountPercent ?? "", discountLabel: p.discountLabel || "",
  };
}

function productFormHTML(f: ProductForm): string {
  return `
    <div class="calc__row2">
      <label>Название *
        <input name="name" required value="${esc(f.name)}" placeholder="iPhone 16 Pro Max" />
      </label>
      <label>Бренд
        <input name="brand" value="${esc(f.brand)}" placeholder="Apple" />
      </label>
    </div>
    <div class="calc__row2">
      <label>Категория
        <input name="category" value="${esc(f.category)}" placeholder="Смартфоны" list="categorySuggestions" />
      </label>
      <label>Группа
        <select name="productGroup">
          <option value="">— подобрать автоматически —</option>
          ${state.groups.map((g) => `<option value="${g}" ${f.productGroup === g ? "selected" : ""}>${g}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="calc__row2">
      <label>Цена *
        <input name="price" type="number" min="0" step="0.01" required value="${f.price}" />
      </label>
      <label>Валюта
        <select name="currency">
          ${["USD", "KGS", "RUB"].map((c) => `<option value="${c}" ${f.currency === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </label>
    </div>

    <label>Варианты памяти (через запятую — цена растёт с объёмом автоматически)
      <input name="storage" value="${esc(f.storage)}" placeholder="128 GB, 256 GB, 512 GB" />
    </label>
    <div class="calc__row2">
      <label>Цвет (если один)
        <input name="color" value="${esc(f.color)}" placeholder="Чёрный" />
      </label>
      <label>Вариант (если не про память — напр. «Body+Face»)
        <input name="variant" value="${esc(f.variant)}" />
      </label>
    </div>

    <div class="admin__block">
      <p class="opt__title">Доступные цвета (необязательно)</p>
      <div class="admin__swatches"></div>
      <button type="button" class="admin__link admin__sw-add">+ добавить цвет</button>
    </div>

    <label>Описание
      <textarea name="description" rows="3" placeholder="Короткое описание товара">${esc(f.description)}</textarea>
    </label>

    ${imageFieldHTML("image", f.image, "Главное фото")}
    <label>Доп. фото — URL по одному на строку
      <textarea name="images" rows="2">${esc(f.images)}</textarea>
    </label>

    <div class="admin__block admin__discount">
      <p class="opt__title">Акция</p>
      <div class="calc__row2">
        <label>Процент скидки (1–99, пусто — без акции)
          <input name="discountPercent" type="number" min="1" max="99" value="${f.discountPercent}" />
        </label>
        <label>Подпись акции
          <input name="discountLabel" value="${esc(f.discountLabel)}" placeholder="Летняя распродажа" />
        </label>
      </div>
      <p class="admin__discountPreview" id="discountPreview"></p>
    </div>

    <label class="admin__checkbox">
      <input type="checkbox" name="available" ${f.available ? "checked" : ""} /> В наличии
    </label>`;
}

function wireDiscountPreview(formEl: HTMLFormElement): void {
  const priceInput = formEl.elements.namedItem("price") as HTMLInputElement;
  const pctInput = formEl.elements.namedItem("discountPercent") as HTMLInputElement;
  const currency = formEl.elements.namedItem("currency") as HTMLSelectElement;
  const out = formEl.querySelector("#discountPreview") as HTMLElement;

  const update = () => {
    const price = Number(priceInput.value);
    const pct = Number(pctInput.value);
    if (!price || !pct || pct <= 0 || pct >= 100) {
      out.textContent = "";
      return;
    }
    const sale = Math.round(price * (1 - pct / 100) * 100) / 100;
    out.innerHTML = `Цена по акции: <b>${fmtMoney(sale, currency.value)}</b> <s>${fmtMoney(price, currency.value)}</s>`;
  };
  [priceInput, pctInput, currency].forEach((el) => el.addEventListener("input", update));
  update();
}

function readProductForm(formEl: HTMLFormElement) {
  const fd = new FormData(formEl);
  const str = (k: string) => (fd.get(k) as string) || "";
  return {
    name: str("name").trim(),
    brand: str("brand").trim() || undefined,
    category: str("category").trim() || undefined,
    productGroup: str("productGroup") || undefined,
    color: str("color").trim() || undefined,
    variant: str("variant").trim() || undefined,
    price: fd.get("price"),
    currency: fd.get("currency"),
    storageOptions: str("storage").trim() || "",
    description: str("description").trim() || undefined,
    image: str("image").trim() || undefined,
    images: str("images").trim() || "",
    swatches: readSwatches(formEl),
    discountPercent: str("discountPercent").trim() ?? "",
    discountLabel: str("discountLabel").trim() || undefined,
    available: (formEl.elements.namedItem("available") as HTMLInputElement).checked,
  };
}

function renderProductsView(): string {
  const editing = state.editingProductSlug ? state.products.find((p) => p.slug === state.editingProductSlug) : null;
  const f = editing ? productToForm(editing) : emptyProductForm();

  return `
    <div class="admin__head">
      <div>
        <p class="eyebrow">Товары</p>
        <h1 class="section__title">${editing ? "Редактировать товар" : "Добавить товар"}</h1>
      </div>
      ${editing ? `<button type="button" class="btn btn--ghost" id="btnCancelEdit">Отменить редактирование</button>` : ""}
    </div>

    <datalist id="categorySuggestions">${state.categorySuggestions.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>

    <form id="productForm" class="calc admin__form">
      ${productFormHTML(f)}
      <div class="admin__formActions">
        <button type="submit" class="btn">${editing ? "Сохранить" : "Добавить товар"}</button>
      </div>
      <p class="admin__formMsg" id="formMsg"></p>
    </form>

    <div class="admin__listHead">
      <h2 class="section__title">Каталог (${state.products.length})</h2>
      <div class="admin__listControls">
        <input type="search" id="productSearch" placeholder="Поиск по названию, бренду…" value="${esc(state.search)}" />
        <select id="productSort">
          <option value="updated_desc" ${state.sortBy === "updated_desc" ? "selected" : ""}>Сначала недавно изменённые</option>
          <option value="group" ${state.sortBy === "group" ? "selected" : ""}>По группе</option>
          <option value="brand" ${state.sortBy === "brand" ? "selected" : ""}>По бренду</option>
          <option value="price_asc" ${state.sortBy === "price_asc" ? "selected" : ""}>Цена: по возрастанию</option>
          <option value="price_desc" ${state.sortBy === "price_desc" ? "selected" : ""}>Цена: по убыванию</option>
          <option value="status" ${state.sortBy === "status" ? "selected" : ""}>По статусу</option>
        </select>
        <label class="admin__checkbox">
          <input type="checkbox" id="showHidden" /> показывать скрытые
        </label>
      </div>
    </div>
    <div class="admin__products" id="productsList"></div>`;
}

const STATUS_LABEL: Record<string, string> = { active: "активен", needs_research: "нужно уточнить", hidden: "скрыт", sync_error: "ошибка" };

function productRowHTML(p: AdminProduct): string {
  const configLine = [
    p.storageOptions?.length ? p.storageOptions.join(" / ") : null,
    p.swatches?.length ? `цвета: ${p.swatches.map((s) => s[0]).join(", ")}` : null,
    p.variant,
  ].filter(Boolean).join(" · ");

  const priceHTML = p.salePrice
    ? `<b class="admin__price--sale">${fmtMoney(p.salePrice, p.currency)}</b> <s>${fmtMoney(p.price, p.currency)}</s> <span class="admin__discountTag">−${p.discountPercent}%</span>`
    : `<b>${fmtMoney(p.price, p.currency)}</b>`;

  return `<article class="admin__prow" data-slug="${p.slug}">
    <div class="admin__prow-media">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="admin__ph">${esc((p.name || "?")[0])}</span>`}</div>
    <div class="admin__prow-main">
      <div class="admin__prow-top">
        <b class="admin__prow-name">${esc(p.name)}</b>
        <span class="admin__prow-tag">${esc(p.brand || "")}${p.brand && p.group ? " · " : ""}${esc(p.group || "")}</span>
      </div>
      ${configLine ? `<p class="admin__prow-config">${esc(configLine)}</p>` : ""}
    </div>
    <div class="admin__prow-price">${priceHTML}</div>
    <div class="admin__prow-status"><span class="admin__status admin__status--${p.status}">${STATUS_LABEL[p.status] || p.status}</span></div>
    <div class="admin__prow-updated">${fmtRelative(p.updatedAt)}</div>
    <div class="admin__prow-actions">
      <button type="button" class="admin__link" data-edit="${p.slug}">Править</button>
      ${p.status === "hidden"
        ? `<button type="button" class="admin__link" data-restore="${p.slug}">Вернуть</button>`
        : `<button type="button" class="admin__link admin__link--danger" data-hide="${p.slug}">Скрыть</button>`}
      <button type="button" class="admin__link admin__link--delete" data-delete="${p.slug}" data-name="${esc(p.name)}">Удалить</button>
    </div>
  </article>`;
}

const GROUP_ORDER = ["Гаджеты", "Игры", "Аксессуары", "Другое"];
function sortProducts(list: AdminProduct[]): AdminProduct[] {
  const arr = [...list];
  switch (state.sortBy) {
    case "group":
      return arr.sort((a, b) => GROUP_ORDER.indexOf(a.group as string) - GROUP_ORDER.indexOf(b.group as string) || a.name.localeCompare(b.name, "ru"));
    case "brand":
      return arr.sort((a, b) => (a.brand || "").localeCompare(b.brand || "", "ru") || a.name.localeCompare(b.name, "ru"));
    case "price_asc":
      return arr.sort((a, b) => (a.salePrice ?? a.price) - (b.salePrice ?? b.price));
    case "price_desc":
      return arr.sort((a, b) => (b.salePrice ?? b.price) - (a.salePrice ?? a.price));
    case "status":
      return arr.sort((a, b) => a.status.localeCompare(b.status));
    default:
      return arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
}

function renderProductsList(): void {
  const list = document.getElementById("productsList");
  if (!list) return;
  const showHidden = (document.getElementById("showHidden") as HTMLInputElement | null)?.checked;
  const q = state.search.trim().toLowerCase();

  let filtered = state.products.filter((p) => showHidden || p.status !== "hidden");
  if (q) filtered = filtered.filter((p) => `${p.name} ${p.brand || ""} ${p.category || ""}`.toLowerCase().includes(q));
  filtered = sortProducts(filtered);

  list.innerHTML = filtered.length
    ? filtered.map(productRowHTML).join("")
    : `<p class="admin__empty">Ничего не найдено</p>`;

  list.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      state.editingProductSlug = b.dataset.edit as string;
      renderView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    })
  );
  list.querySelectorAll<HTMLElement>("[data-hide]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Скрыть товар с витрины?")) return;
      await api("DELETE", `/products/${encodeURIComponent(b.dataset.hide as string)}`);
      await loadProducts();
    })
  );
  list.querySelectorAll<HTMLElement>("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("POST", `/products/${encodeURIComponent(b.dataset.restore as string)}/restore`);
      await loadProducts();
    })
  );
  list.querySelectorAll<HTMLElement>("[data-delete]").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = b.dataset.name || "этот товар";
      if (!confirm(`Удалить «${name}» навсегда? Это действие нельзя отменить.`)) return;
      await api("DELETE", `/products/${encodeURIComponent(b.dataset.delete as string)}/permanent`);
      if (state.editingProductSlug === b.dataset.delete) state.editingProductSlug = null;
      toast("Товар удалён");
      await loadProducts();
    })
  );
}

async function loadProducts(): Promise<void> {
  try {
    const { products, groups, categorySuggestions } = await api<{ products: AdminProduct[]; groups?: string[]; categorySuggestions?: string[] }>("GET", "/products");
    state.products = products;
    if (groups?.length) state.groups = groups;
    if (categorySuggestions?.length) {
      state.categorySuggestions = categorySuggestions;
      const dl = document.getElementById("categorySuggestions");
      if (dl) dl.innerHTML = categorySuggestions.map((c) => `<option value="${esc(c)}">`).join("");
    }
    renderProductsList();
  } catch (err) {
    const list = document.getElementById("productsList");
    if (list) list.innerHTML = `<p class="admin__error">${esc((err as Error).message)}</p>`;
  }
}

function wireProductsView(): void {
  const formEl = document.getElementById("productForm") as HTMLFormElement;
  const editing = state.editingProductSlug ? state.products.find((p) => p.slug === state.editingProductSlug) : null;

  wireImageField(formEl, "image");
  wireSwatches(formEl, editing?.swatches);
  wireDiscountPreview(formEl);

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("formMsg") as HTMLElement;
    msg.textContent = "Сохраняю…";
    msg.className = "admin__formMsg";
    try {
      const body = readProductForm(formEl);
      const result = state.editingProductSlug
        ? await api<{ warnings?: string[] }>("PUT", `/products/${encodeURIComponent(state.editingProductSlug)}`, body)
        : await api<{ warnings?: string[] }>("POST", "/products", body);
      msg.textContent = result.warnings?.length ? `Сохранено. ${result.warnings.join(" ")}` : "Сохранено.";
      msg.className = "admin__formMsg admin__formMsg--ok";
      state.editingProductSlug = null;
      await loadProducts();
      setTimeout(() => renderView(), 900);
    } catch (err) {
      msg.textContent = (err as Error).message;
      msg.className = "admin__formMsg admin__formMsg--error";
    }
  });

  document.getElementById("btnCancelEdit")?.addEventListener("click", () => {
    state.editingProductSlug = null;
    renderView();
  });

  document.getElementById("productSearch")!.addEventListener("input", (e) => {
    state.search = (e.target as HTMLInputElement).value;
    renderProductsList();
  });
  document.getElementById("productSort")!.addEventListener("change", (e) => {
    state.sortBy = (e.target as HTMLSelectElement).value as ProductSort;
    renderProductsList();
  });
  document.getElementById("showHidden")!.addEventListener("change", renderProductsList);

  loadProducts();
}

// --- Вкладка «Новости» -------------------------------------------------

function postFormHTML(f: Partial<Post>): string {
  return `
    <label>Заголовок *
      <input name="title" required value="${esc(f.title || "")}" placeholder="Новая партия iPhone в наличии" />
    </label>
    <label>Текст *
      <textarea name="body" rows="4" required placeholder="Текст новости">${esc(f.body || "")}</textarea>
    </label>
    ${imageFieldHTML("image", f.image, "Фото (необязательно)")}
    <label>Статус
      <select name="status">
        <option value="published" ${f.status !== "draft" ? "selected" : ""}>Опубликовано</option>
        <option value="draft" ${f.status === "draft" ? "selected" : ""}>Черновик (не виден на сайте)</option>
      </select>
    </label>`;
}

function renderNewsView(): string {
  const editing = state.editingPostSlug ? state.posts.find((p) => p.slug === state.editingPostSlug) : null;
  return `
    <div class="admin__head">
      <div>
        <p class="eyebrow">Новости</p>
        <h1 class="section__title">${editing ? "Редактировать новость" : "Добавить новость"}</h1>
      </div>
      ${editing ? `<button type="button" class="btn btn--ghost" id="btnCancelPostEdit">Отменить редактирование</button>` : ""}
    </div>
    <form id="postForm" class="calc admin__form">
      ${postFormHTML(editing || {})}
      <div class="admin__formActions">
        <button type="submit" class="btn">${editing ? "Сохранить" : "Опубликовать"}</button>
      </div>
      <p class="admin__formMsg" id="postFormMsg"></p>
    </form>

    <div class="admin__listHead"><h2 class="section__title">Все новости (${state.posts.length})</h2></div>
    <div class="admin__tableWrap">
      <table class="admin__table" id="postsTable"></table>
    </div>`;
}

function renderPostsTable(): void {
  const table = document.getElementById("postsTable");
  if (!table) return;
  table.innerHTML = `
    <thead><tr><th></th><th>Заголовок</th><th>Статус</th><th>Дата</th><th></th></tr></thead>
    <tbody>
      ${state.posts
        .map(
          (p) => `<tr data-slug="${p.slug}">
            <td class="admin__thumb">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</td>
            <td><b>${esc(p.title)}</b></td>
            <td><span class="admin__status admin__status--${p.status === "published" ? "active" : "hidden"}">${p.status === "published" ? "опубликовано" : "черновик"}</span></td>
            <td class="admin__muted">${fmtRelative(p.publishedAt)}</td>
            <td class="admin__actions">
              <button type="button" class="admin__link" data-edit-post="${p.slug}">Править</button>
              <button type="button" class="admin__link admin__link--danger" data-del-post="${p.slug}">Удалить</button>
            </td>
          </tr>`
        )
        .join("") || `<tr><td colspan="5" class="admin__empty">Пока нет новостей</td></tr>`}
    </tbody>`;

  table.querySelectorAll<HTMLElement>("[data-edit-post]").forEach((b) =>
    b.addEventListener("click", () => {
      state.editingPostSlug = b.dataset.editPost as string;
      renderView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    })
  );
  table.querySelectorAll<HTMLElement>("[data-del-post]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Удалить новость безвозвратно?")) return;
      await api("DELETE", `/posts/${encodeURIComponent(b.dataset.delPost as string)}`);
      await loadPosts();
    })
  );
}

async function loadPosts(): Promise<void> {
  try {
    const { posts } = await api<{ posts: Post[] }>("GET", "/posts");
    state.posts = posts;
    renderPostsTable();
  } catch (err) {
    toast((err as Error).message, false);
  }
}

function wireNewsView(): void {
  const formEl = document.getElementById("postForm") as HTMLFormElement;
  wireImageField(formEl, "image");

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("postFormMsg") as HTMLElement;
    msg.textContent = "Сохраняю…";
    msg.className = "admin__formMsg";
    const fd = new FormData(formEl);
    const body = {
      title: (fd.get("title") as string || "").trim(),
      body: (fd.get("body") as string || "").trim(),
      image: (fd.get("image") as string || "").trim(),
      status: fd.get("status"),
    };
    try {
      if (state.editingPostSlug) await api("PUT", `/posts/${encodeURIComponent(state.editingPostSlug)}`, body);
      else await api("POST", "/posts", body);
      msg.textContent = "Сохранено.";
      msg.className = "admin__formMsg admin__formMsg--ok";
      state.editingPostSlug = null;
      await loadPosts();
      setTimeout(() => renderView(), 900);
    } catch (err) {
      msg.textContent = (err as Error).message;
      msg.className = "admin__formMsg admin__formMsg--error";
    }
  });

  document.getElementById("btnCancelPostEdit")?.addEventListener("click", () => {
    state.editingPostSlug = null;
    renderView();
  });

  loadPosts();
}

// --- Вкладка «Обновления» (журнал изменения цен) ----------------------

function renderHistoryView(): string {
  return `
    <div class="admin__head">
      <div>
        <p class="eyebrow">Обновления</p>
        <h1 class="section__title">Изменения цен</h1>
      </div>
    </div>
    <div class="admin__tableWrap">
      <table class="admin__table" id="historyTable"></table>
    </div>`;
}

function renderHistoryTable(): void {
  const table = document.getElementById("historyTable");
  if (!table) return;
  table.innerHTML = `
    <thead><tr><th>Когда</th><th>Товар</th><th>Было</th><th>Стало</th><th>Источник</th></tr></thead>
    <tbody>
      ${state.history
        .map(
          (c) => `<tr>
            <td class="admin__muted">${fmtRelative(c.changedAt)}</td>
            <td>${c.productSlug ? `<a href="#" data-goto="${c.productSlug}">${esc(c.productName)}</a>` : esc(c.productName)}</td>
            <td>${c.oldPrice == null ? "<span class=\"admin__muted\">новый товар</span>" : fmtMoney(c.oldPrice, c.currency)}</td>
            <td><b>${fmtMoney(c.newPrice, c.currency)}</b></td>
            <td><span class="admin__status admin__status--${c.source === "telegram" ? "active" : "needs_research"}">${c.source === "telegram" ? "Telegram" : "Админка"}</span></td>
          </tr>`
        )
        .join("") || `<tr><td colspan="5" class="admin__empty">Изменений пока нет</td></tr>`}
    </tbody>`;

  table.querySelectorAll<HTMLElement>("[data-goto]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.view = "products";
      state.editingProductSlug = a.dataset.goto as string;
      renderView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    })
  );
}

async function loadHistory(): Promise<void> {
  try {
    const { changes } = await api<{ changes: PriceChange[] }>("GET", "/price-history");
    state.history = changes;
    renderHistoryTable();
  } catch (err) {
    toast((err as Error).message, false);
  }
}

// --- Общий каркас: вкладки + рендер ------------------------------------

const TABS: { id: AdminView; label: string }[] = [
  { id: "products", label: "Товары" },
  { id: "news", label: "Новости" },
  { id: "history", label: "Обновления" },
];

function tabsHTML(): string {
  return `<nav class="admin__tabs">
    ${TABS.map((t) => `<button type="button" class="admin__tab ${state.view === t.id ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
  </nav>`;
}

function renderView(): void {
  if (!state.authenticated) return renderLogin();
  btnLogout.hidden = false;

  const body = state.view === "news" ? renderNewsView() : state.view === "history" ? renderHistoryView() : renderProductsView();
  root.innerHTML = tabsHTML() + `<div class="admin__view">${body}</div>`;

  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.tab as AdminView;
      state.editingProductSlug = null;
      state.editingPostSlug = null;
      renderView();
    })
  );

  if (state.view === "news") wireNewsView();
  else if (state.view === "history") loadHistory();
  else wireProductsView();
}

btnLogout.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  state.authenticated = false;
  renderView();
});

(async function init() {
  await checkSession();
  renderView();
})();
