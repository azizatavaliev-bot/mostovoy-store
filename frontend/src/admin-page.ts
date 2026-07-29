// Админка: вход по логину/паролю (сессия — httpOnly cookie, ставит и проверяет
// сервер), товары (фото по URL или загрузкой, описание, цена, диапазон
// памяти, доступные цвета, акции), новости, журнал изменения цен.
//
// Всё ходит в /api/admin/* — тот же API, что доступен из терминала
// (npm run admin, по ADMIN_TOKEN) и curl'ом напрямую.
import "./styles.css";
import { optimizedImageUrl } from "./image-url";

type Swatch = [string, string];
type ProductStatus = "active" | "needs_research" | "hidden" | "sync_error";
type CurrencyCode = "USD" | "KGS" | "RUB";

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

interface CrmConversation {
  id: number;
  source: "telegram" | "whatsapp" | "amocrm";
  externalChatId: string;
  externalLeadId?: string;
  customerName: string;
  customerUsername?: string;
  customerPhone?: string;
  aiEnabled: boolean;
  unreadCount: number;
  notes: string;
  status: "open" | "closed";
  lastMessageAt: string;
  lastMessage: string;
}

interface CrmMessage {
  id: number;
  direction: "incoming" | "outgoing";
  sender: "customer" | "assistant" | "manager";
  text: string;
  status: string;
  createdAt: string;
}

interface CrmDetail {
  conversation: CrmConversation;
  messages: CrmMessage[];
}

interface CrmStatus {
  telegram: boolean;
  amocrm: boolean;
  ai: boolean;
  amocrmWebhook: string;
}

interface CrmAnalytics {
  periodDays: number;
  summary: {
    clicks: number;
    units: number;
    visitors: number;
    handoffs: number;
  };
  topProducts: {
    productSlug: string | null;
    productName: string;
    clicks: number;
    units: number;
  }[];
  trend: { day: string; clicks: number }[];
  sources: { source: "product" | "cart" | "credit"; clicks: number }[];
  recent: {
    id: string;
    source: "product" | "cart";
    clickedAt: string;
    items: { productSlug: string | null; productName: string; quantity: number }[];
  }[];
}

interface BotSettings {
  approvalEnabled: boolean;
  aggressiveLearning: boolean;
  model: string;
  models: {
    id: string;
    label: string;
    provider: "deepseek" | "openai" | "gemini";
    enabled: boolean;
  }[];
  systemPrompt: string;
  hypervisorPrompt: string;
  characterPrompt: string;
  rulesPrompt: string;
  taskPrompt: string;
}

interface BotApproval {
  id: number;
  conversationId: number;
  customerName: string;
  source: "telegram" | "whatsapp" | "amocrm";
  customerMessage: string;
  aiReply: string;
  editedReply?: string;
  rejectReason?: string;
  summary?: string;
  model?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

interface BotEvent {
  id: number;
  conversationId?: number;
  level: "info" | "warn" | "error";
  stage: string;
  event: string;
  message?: string;
  createdAt: string;
}

interface DeveloperStatus {
  enabled: boolean;
  settings: BotSettings;
  approvals: { total: number; pending: number; approved: number; rejected: number };
  errors24h: number;
}

interface AiUsageAnalytics {
  overview: {
    conversations: number;
    messages: number;
    aiReplies: number;
    approved: number;
    withoutEdits: number;
    rejected: number;
  };
  periods: Record<"today" | "averageDay" | "month" | "year" | "all", {
    tokens: number;
    costUsd: number;
  }>;
  tasks: { task: string; model: string; calls: number; tokens: number; costUsd: number }[];
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
}

interface LabMessage {
  role: "user" | "assistant";
  content: string;
  latencyMs?: number;
  model?: string;
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

type AdminView = "products" | "news" | "history" | "crm" | "approvals" | "analytics" | "developer";
type ProductSort = "updated_desc" | "group" | "brand" | "price_asc" | "price_desc" | "status";

const root = document.getElementById("admin") as HTMLElement;
const btnLogout = document.getElementById("btnLogout") as HTMLButtonElement;
const btnTheme = document.getElementById("btnTheme") as HTMLButtonElement;
const btnToTop = document.getElementById("btnToTop") as HTMLButtonElement;

const state = {
  authenticated: false,
  loginEnabled: true,
  view: "products" as AdminView,
  products: [] as AdminProduct[],
  groups: ["Гаджеты", "Игры", "Аксессуары", "Другое"],
  categorySuggestions: [] as string[],
  posts: [] as Post[],
  history: [] as PriceChange[],
  crmConversations: [] as CrmConversation[],
  crmDetail: null as CrmDetail | null,
  crmStatus: null as CrmStatus | null,
  crmSearch: "",
  approvals: [] as BotApproval[],
  approvalFilter: "pending" as "pending" | "all",
  developerStatus: null as DeveloperStatus | null,
  aiUsage: null as AiUsageAnalytics | null,
  botEvents: [] as BotEvent[],
  labHistory: [] as LabMessage[],
  analyticsDays: 30,
  visibleProducts: 30,
  editingProductSlug: null as string | null,
  editingPostSlug: null as string | null,
  search: "",
  sortBy: "updated_desc" as ProductSort,
  displayCurrency: (["USD", "KGS", "RUB"].includes(localStorage.getItem("mostovoy_currency") || "")
    ? localStorage.getItem("mostovoy_currency")
    : "USD") as CurrencyCode,
  rates: { USD: 1, KGS: 87.5, RUB: 79 } as Record<CurrencyCode, number>,
  loginError: null as string | null,
};

function applyAdminTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.adminTheme = theme;
  localStorage.setItem("mostovoy_admin_theme", theme);
  btnTheme.textContent = theme === "dark" ? "☀" : "☾";
  btnTheme.setAttribute("aria-label", theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему");
}

applyAdminTheme(localStorage.getItem("mostovoy_admin_theme") === "dark" ? "dark" : "light");
btnTheme.addEventListener("click", () => {
  applyAdminTheme(document.documentElement.dataset.adminTheme === "dark" ? "light" : "dark");
});
btnToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

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

const DISPLAY_CURRENCIES: Record<CurrencyCode, { label: string; suffix: string }> = {
  USD: { label: "USD · $", suffix: "$" },
  KGS: { label: "KGS · с", suffix: "с" },
  RUB: { label: "RUB · ₽", suffix: "₽" },
};

function convertDisplayPrice(amount: number, from: string): number {
  const sourceRate = state.rates[from as CurrencyCode] || 1;
  return (amount / sourceRate) * state.rates[state.displayCurrency];
}

function fmtDisplayMoney(n: number | null | undefined, currency: string): string {
  if (n == null) return "—";
  const converted = convertDisplayPrice(n, currency);
  const step = state.displayCurrency === "USD" ? 10 : 100;
  const rounded = Math.ceil(converted / step) * step;
  return `${rounded.toLocaleString("ru-RU")} ${DISPLAY_CURRENCIES[state.displayCurrency].suffix}`;
}

function currencySwitchHTML(id: string): string {
  return `<label class="admin__currencySwitch" for="${id}">
    <span>Показывать цены</span>
    <select id="${id}" aria-label="Валюта отображения">
      ${Object.entries(DISPLAY_CURRENCIES)
        .map(([code, currency]) => `<option value="${code}" ${state.displayCurrency === code ? "selected" : ""}>${currency.label}</option>`)
        .join("")}
    </select>
  </label>`;
}

function setAdminDisplayCurrency(code: CurrencyCode): void {
  state.displayCurrency = code;
  localStorage.setItem("mostovoy_currency", code);
  document.dispatchEvent(new CustomEvent("currency:change", { detail: { code } }));
}

async function loadDisplayRates(): Promise<void> {
  try {
    const response = await fetch("/api/catalog", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data = (await response.json()) as { rates?: Partial<Record<CurrencyCode, number>> };
    if (data.rates) state.rates = { ...state.rates, ...data.rates };
  } catch {
    // Если каталог временно недоступен, админка продолжает работать на резервных курсах.
  }
}

function fmtUsd(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const then = new Date(normalized).getTime();
  if (!Number.isFinite(then)) return "—";
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
        ${currencySwitchHTML("productDisplayCurrency")}
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
    ? `<b class="admin__price--sale">${fmtDisplayMoney(p.salePrice, p.currency)}</b> <s>${fmtDisplayMoney(p.price, p.currency)}</s> <span class="admin__discountTag">−${p.discountPercent}%</span>`
    : `<b>${fmtDisplayMoney(p.price, p.currency)}</b>`;

  return `<article class="admin__prow" data-slug="${p.slug}">
    <div class="admin__prow-media">${p.image ? `<img src="${esc(optimizedImageUrl(p.image, 96))}" alt="" loading="lazy" decoding="async" fetchpriority="low" onerror="this.remove()">` : `<span class="admin__ph">${esc((p.name || "?")[0])}</span>`}</div>
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
      return arr.sort((a, b) => convertDisplayPrice(a.salePrice ?? a.price, a.currency) - convertDisplayPrice(b.salePrice ?? b.price, b.currency));
    case "price_desc":
      return arr.sort((a, b) => convertDisplayPrice(b.salePrice ?? b.price, b.currency) - convertDisplayPrice(a.salePrice ?? a.price, a.currency));
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
  const visible = filtered.slice(0, state.visibleProducts);
  const remaining = filtered.length - visible.length;

  list.innerHTML = filtered.length
    ? `${visible.map(productRowHTML).join("")}${remaining > 0
      ? `<button type="button" class="btn btn--ghost admin__loadMore" id="productsLoadMore">Показать ещё (${remaining})</button>`
      : ""}`
    : `<p class="admin__empty">Ничего не найдено</p>`;

  document.getElementById("productsLoadMore")?.addEventListener("click", () => {
    state.visibleProducts += 30;
    renderProductsList();
  });

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
    state.visibleProducts = 30;
    renderProductsList();
  });
  document.getElementById("productSort")!.addEventListener("change", (e) => {
    state.sortBy = (e.target as HTMLSelectElement).value as ProductSort;
    state.visibleProducts = 30;
    renderProductsList();
  });
  document.getElementById("productDisplayCurrency")!.addEventListener("change", (e) => {
    setAdminDisplayCurrency((e.target as HTMLSelectElement).value as CurrencyCode);
    renderProductsList();
  });
  document.getElementById("showHidden")!.addEventListener("change", () => {
    state.visibleProducts = 30;
    renderProductsList();
  });

  loadProducts();
}

// --- Вкладка «Посты» ---------------------------------------------------

function postFormHTML(f: Partial<Post>): string {
  return `
    <label>Заголовок *
      <input name="title" required value="${esc(f.title || "")}" placeholder="Новая партия iPhone в наличии" />
    </label>
    <label>Текст *
      <textarea name="body" rows="6" required placeholder="Текст поста">${esc(f.body || "")}</textarea>
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
        <p class="eyebrow">Посты</p>
        <h1 class="section__title">${editing ? "Редактировать пост" : "Новый пост"}</h1>
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

    <div class="admin__listHead"><h2 class="section__title">Все посты (${state.posts.length})</h2></div>
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
            <td class="admin__thumb">${p.image ? `<img src="${esc(optimizedImageUrl(p.image, 96))}" alt="" loading="lazy" decoding="async" fetchpriority="low" onerror="this.remove()">` : ""}</td>
            <td><b>${esc(p.title)}</b></td>
            <td><span class="admin__status admin__status--${p.status === "published" ? "active" : "hidden"}">${p.status === "published" ? "опубликовано" : "черновик"}</span></td>
            <td class="admin__muted">${fmtRelative(p.publishedAt)}</td>
            <td class="admin__actions">
              <button type="button" class="admin__link" data-edit-post="${p.slug}">Править</button>
              <button type="button" class="admin__link admin__link--danger" data-del-post="${p.slug}">Удалить</button>
            </td>
          </tr>`
        )
        .join("") || `<tr><td colspan="5" class="admin__empty">Пока нет постов</td></tr>`}
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
      if (!confirm("Удалить пост безвозвратно?")) return;
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
      ${currencySwitchHTML("historyDisplayCurrency")}
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
            <td>${c.oldPrice == null ? "<span class=\"admin__muted\">новый товар</span>" : fmtDisplayMoney(c.oldPrice, c.currency)}</td>
            <td><b>${fmtDisplayMoney(c.newPrice, c.currency)}</b></td>
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

function wireHistoryView(): void {
  document.getElementById("historyDisplayCurrency")!.addEventListener("change", (e) => {
    setAdminDisplayCurrency((e.target as HTMLSelectElement).value as CurrencyCode);
    renderHistoryTable();
  });
  loadHistory();
}

// --- CRM inbox -------------------------------------------------------------

let crmPoll: ReturnType<typeof setInterval> | undefined;

function crmSourceLabel(source: string): string {
  return source === "telegram" ? "Telegram" : source === "whatsapp" ? "WhatsApp" : "amoCRM";
}

function crmInitial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

function renderCrmView(): string {
  return `
    <div class="admin__head crm__head">
      <div>
        <p class="eyebrow">Единый inbox</p>
        <h1 class="section__title">CRM диалоги</h1>
      </div>
      <div class="crm__status" id="crmStatus"></div>
    </div>
    <div id="crmUsageSummary"></div>
    <div id="crmMount"><div class="crm__loading">Загружаем диалоги…</div></div>`;
}

function renderCrmUsageSummary(): void {
  const mount = document.getElementById("crmUsageSummary");
  const usage = state.aiUsage;
  if (!mount || !usage) return;
  const cards: [string, number | string][] = [
    ["Диалогов", usage.overview.conversations],
    ["Сообщений", usage.overview.messages],
    ["AI ответов", usage.overview.aiReplies],
    ["Принято", usage.overview.approved],
    ["Без правок", usage.overview.withoutEdits],
    ["Отклонено", usage.overview.rejected],
    ["Расход AI", fmtUsd(usage.periods.all.costUsd)],
  ];
  mount.innerHTML = `<section class="crm-usage-summary">${cards.map(([label, value]) =>
    `<article><strong>${typeof value === "number" ? value.toLocaleString("ru-RU") : value}</strong><span>${label}</span></article>`
  ).join("")}</section>`;
}

function renderCrmStatus(): void {
  const el = document.getElementById("crmStatus");
  if (!el || !state.crmStatus) return;
  const item = (label: string, ok: boolean) =>
    `<span class="${ok ? "is-on" : "is-off"}"><i></i>${label}${ok ? "" : " — настройте"}</span>`;
  el.innerHTML =
    item("Telegram", state.crmStatus.telegram) +
    item("WhatsApp · amoCRM", state.crmStatus.amocrm) +
    item("AI", state.crmStatus.ai);
}

function renderCrmMount(): void {
  const mount = document.getElementById("crmMount");
  if (!mount) return;
  const q = state.crmSearch.trim().toLowerCase();
  const conversations = state.crmConversations.filter((c) =>
    `${c.customerName} ${c.customerUsername || ""} ${c.customerPhone || ""} ${c.lastMessage}`.toLowerCase().includes(q)
  );
  const detail = state.crmDetail;
  const selected = detail?.conversation;

  mount.innerHTML = `
    <div class="crm">
      <aside class="crm__inbox">
        <div class="crm__inboxTop">
          <b>Все диалоги</b><span>${state.crmConversations.length}</span>
        </div>
        <label class="crm__search">
          <span>⌕</span>
          <input type="search" id="crmSearch" placeholder="Имя или сообщение" value="${esc(state.crmSearch)}" />
        </label>
        <div class="crm__threads">
          ${conversations.map((c) => `
            <button type="button" class="crm__thread ${selected?.id === c.id ? "active" : ""}" data-crm-id="${c.id}">
              <span class="crm__avatar">${esc(crmInitial(c.customerName))}</span>
              <span class="crm__threadBody">
                <span class="crm__threadLine"><b>${esc(c.customerName)}</b><time>${esc(fmtRelative(c.lastMessageAt))}</time></span>
                <span class="crm__threadLine crm__threadMeta">
                  <em class="crm__source crm__source--${esc(c.source)}">${crmSourceLabel(c.source)}</em>
                  <small>${esc(c.lastMessage || "Новый диалог")}</small>
                </span>
              </span>
              ${c.unreadCount ? `<strong class="crm__unread">${c.unreadCount}</strong>` : ""}
            </button>`).join("") || `<div class="crm__empty">Диалогов пока нет.<br />Напишите боту, чтобы проверить CRM.</div>`}
        </div>
      </aside>

      <section class="crm__chat">
        ${detail ? `
          <header class="crm__chatHead">
            <span class="crm__avatar crm__avatar--large">${esc(crmInitial(selected!.customerName))}</span>
            <div><b>${esc(selected!.customerName)}</b><small>${crmSourceLabel(selected!.source)} · ${selected!.aiEnabled ? "AI отвечает" : "ручной режим"}</small></div>
            <label class="crm__aiSwitch" title="Автоответы AI">
              <input type="checkbox" id="crmAiToggle" ${selected!.aiEnabled ? "checked" : ""} />
              <span></span><b>AI</b>
            </label>
          </header>
          <div class="crm__messages" id="crmMessages">
            ${detail.messages.map((m) => `
              <article class="crm__message crm__message--${m.direction}">
                <p>${esc(m.text).replace(/\n/g, "<br />")}</p>
                <footer>${m.sender === "assistant" ? "AI" : m.sender === "manager" ? "Менеджер" : esc(selected!.customerName)} · ${esc(fmtRelative(m.createdAt))}</footer>
              </article>`).join("") || `<div class="crm__empty">Сообщений пока нет</div>`}
          </div>
          <form class="crm__composer" id="crmComposer">
            <textarea name="text" rows="1" maxlength="4000" placeholder="Написать клиенту…" required></textarea>
            <button type="submit" class="btn btn--sm">Отправить <span>↗</span></button>
          </form>` : `
          <div class="crm__welcome">
            <span class="logo__badge" aria-hidden="true"></span>
            <h2>Выберите диалог</h2>
            <p>Здесь появится переписка клиента с ботом или WhatsApp.</p>
          </div>`}
      </section>

      <aside class="crm__customer">
        ${detail ? `
          <div class="crm__customerHero">
            <span class="crm__avatar crm__avatar--xl">${esc(crmInitial(selected!.customerName))}</span>
            <h3>${esc(selected!.customerName)}</h3>
            <span class="crm__source crm__source--${esc(selected!.source)}">${crmSourceLabel(selected!.source)}</span>
          </div>
          <dl class="crm__facts">
            <div><dt>Контакт</dt><dd>${esc(selected!.customerPhone || selected!.customerUsername || "Не указан")}</dd></div>
            <div><dt>ID диалога</dt><dd>${esc(selected!.externalChatId)}</dd></div>
            ${selected!.externalLeadId ? `<div><dt>Сделка amoCRM</dt><dd>#${esc(selected!.externalLeadId)}</dd></div>` : ""}
            <div><dt>Последняя активность</dt><dd>${esc(fmtRelative(selected!.lastMessageAt))}</dd></div>
          </dl>
          <label class="crm__notes">Заметка менеджера
            <textarea id="crmNotes" rows="5" placeholder="Что важно помнить о клиенте">${esc(selected!.notes)}</textarea>
          </label>
          <button type="button" class="btn btn--ghost crm__saveNotes" id="crmSaveNotes">Сохранить заметку</button>` : `
          <div class="crm__customerBlank">
            <p class="eyebrow">Карточка клиента</p>
            <p>Контакты, источник и заметки откроются вместе с диалогом.</p>
          </div>`}
        <div class="crm__settings">
          <b>Управление ботом</b>
          <p>Подтверждение ответов, промпты, модель и диагностика находятся во вкладках «Ответы бота» и «Разработчикам».</p>
          ${state.crmStatus ? `<p>Webhook amoCRM:<br /><code>${esc(state.crmStatus.amocrmWebhook)}</code></p>` : ""}
        </div>
      </aside>
    </div>`;

  wireCrmMount();
  const messages = document.getElementById("crmMessages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function wireCrmMount(): void {
  document.querySelectorAll<HTMLElement>("[data-crm-id]").forEach((button) =>
    button.addEventListener("click", () => loadCrmConversation(Number(button.dataset.crmId)))
  );
  document.getElementById("crmSearch")?.addEventListener("input", (event) => {
    state.crmSearch = (event.target as HTMLInputElement).value;
    renderCrmMount();
    const field = document.getElementById("crmSearch") as HTMLInputElement | null;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  });
  document.getElementById("crmAiToggle")?.addEventListener("change", async (event) => {
    if (!state.crmDetail) return;
    const aiEnabled = (event.target as HTMLInputElement).checked;
    state.crmDetail = await api<CrmDetail>("PATCH", `/crm/conversations/${state.crmDetail.conversation.id}`, { aiEnabled });
    state.crmConversations = state.crmConversations.map((c) => c.id === state.crmDetail!.conversation.id ? state.crmDetail!.conversation : c);
    renderCrmMount();
  });
  document.getElementById("crmSaveNotes")?.addEventListener("click", async () => {
    if (!state.crmDetail) return;
    const notes = (document.getElementById("crmNotes") as HTMLTextAreaElement).value;
    state.crmDetail = await api<CrmDetail>("PATCH", `/crm/conversations/${state.crmDetail.conversation.id}`, { notes });
    toast("Заметка сохранена");
  });
  document.getElementById("crmComposer")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.crmDetail) return;
    const form = event.target as HTMLFormElement;
    const field = form.elements.namedItem("text") as HTMLTextAreaElement;
    const text = field.value.trim();
    if (!text) return;
    const button = form.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    try {
      state.crmDetail = await api<CrmDetail>("POST", `/crm/conversations/${state.crmDetail.conversation.id}/messages`, { text });
      renderCrmMount();
    } catch (error) {
      toast((error as Error).message, false);
      button.disabled = false;
    }
  });
}

async function loadCrmConversation(id: number): Promise<void> {
  state.crmDetail = await api<CrmDetail>("GET", `/crm/conversations/${id}`);
  state.crmConversations = state.crmConversations.map((c) =>
    c.id === id ? { ...c, unreadCount: 0 } : c
  );
  renderCrmMount();
}

async function refreshCrmConversations(selectFirst = false): Promise<void> {
  const { conversations } = await api<{ conversations: CrmConversation[] }>("GET", "/crm/conversations");
  state.crmConversations = conversations;
  if (selectFirst && !state.crmDetail && conversations[0]) {
    await loadCrmConversation(conversations[0].id);
  } else {
    renderCrmMount();
  }
}

async function wireCrmView(): Promise<void> {
  try {
    const [status, usage] = await Promise.all([
      api<CrmStatus>("GET", "/crm/status"),
      api<AiUsageAnalytics>("GET", "/crm/developer/usage"),
    ]);
    state.crmStatus = status;
    state.aiUsage = usage;
    renderCrmStatus();
    renderCrmUsageSummary();
    await refreshCrmConversations(true);
    crmPoll = setInterval(() => refreshCrmConversations(false).catch(() => {}), 10000);
  } catch (error) {
    toast((error as Error).message, false);
  }
}

// --- CRM-аналитика переходов в WhatsApp -----------------------------------

function renderAnalyticsView(): string {
  return `
    <div class="admin__head analytics__head">
      <div>
        <p class="eyebrow">Переходы в WhatsApp</p>
        <h1 class="section__title">Что хотят купить</h1>
        <p class="analytics__lead">Считаем товары в момент нажатия «Купить в WhatsApp» на сайте.</p>
      </div>
      <div class="analytics__controls">
        <label class="analytics__period">Период
          <select id="analyticsDays">
            ${[[7, "7 дней"], [30, "30 дней"], [90, "90 дней"], [365, "1 год"]]
              .map(([value, label]) => `<option value="${value}" ${state.analyticsDays === value ? "selected" : ""}>${label}</option>`)
              .join("")}
          </select>
        </label>
      </div>
    </div>
    <div id="analyticsMount"><div class="crm__loading">Собираем аналитику…</div></div>`;
}

function buildDemoAnalytics(days: number): CrmAnalytics {
  const multiplier = ({ 7: 0.32, 30: 1, 90: 2.8, 365: 10.6 } as Record<number, number>)[days] || 1;
  const scale = (value: number) => Math.max(1, Math.round(value * multiplier));
  const productSeeds = [
    ["iphone-17-pro-max-256-gb-belyi-esim", "iPhone 17 Pro Max", 42, 51],
    ["macbook-pro-16-m5-pro-1-tb-space-black-24-gb-ram-mgea4", "MacBook Pro 16 M5 Pro", 31, 34],
    ["airpods-pro-3", "AirPods Pro 3", 27, 39],
    ["dyson-airwrap-hs09-co-anda2x-long-ceramic-pink-koreya-dorozhnaya-sumka-v-podarok", "Dyson Airwrap HS09", 24, 28],
    ["apple-watch-ultra-3-black", "Apple Watch Ultra 3", 19, 22],
    ["galaxy-s26-ultra-512-gb-vse-cveta-2-sim-vetnam", "Galaxy S26 Ultra", 16, 18],
    ["nintendo-switch-2", "Nintendo Switch 2", 12, 15],
  ] as const;
  const pattern = [3, 5, 4, 8, 6, 9, 7, 11, 8, 10, 12, 9, 13, 11, 15, 12, 14, 16, 13, 17, 15, 19, 16, 18, 21, 17, 20, 22, 19, 24];
  const pointCount = Math.min(days, 30);
  const stepDays = Math.max(1, Math.floor(days / pointCount));
  const now = Date.now();
  const trend = Array.from({ length: pointCount }, (_, index) => {
    const date = new Date(now - (pointCount - 1 - index) * stepDays * 86400000);
    return { day: date.toISOString().slice(0, 10), clicks: scale(pattern[index % pattern.length]) };
  });
  const recentSeeds = [
    ["product", "iPhone 17 Pro Max", 1, 8],
    ["cart", "AirPods Pro 3", 2, 24],
    ["product", "MacBook Pro 16 M5 Pro", 1, 51],
    ["cart", "Dyson Airwrap HS09", 1, 83],
    ["product", "Apple Watch Ultra 3", 1, 136],
    ["product", "Galaxy S26 Ultra", 1, 204],
  ] as const;

  return {
    periodDays: days,
    summary: { clicks: scale(186), units: scale(243), visitors: scale(132), handoffs: scale(37) },
    topProducts: productSeeds.map(([productSlug, productName, clicks, units]) => ({
      productSlug, productName, clicks: scale(clicks), units: scale(units),
    })),
    trend,
    sources: [
      { source: "product", clicks: scale(128) },
      { source: "cart", clicks: scale(58) },
    ],
    recent: recentSeeds.map(([source, productName, quantity, minutes], index) => ({
      id: `demo-${index}`,
      source,
      clickedAt: new Date(now - minutes * 60000).toISOString(),
      items: [{ productSlug: null, productName, quantity }],
    })),
  };
}

function renderAnalyticsMount(): void {
  const mount = document.getElementById("analyticsMount");
  if (!mount) return;
  const data = buildDemoAnalytics(state.analyticsDays);
  const maxClicks = Math.max(1, ...data.trend.map((item) => item.clicks));
  const maxProductClicks = Math.max(1, ...data.topProducts.map((item) => item.clicks));
  const sourceTotal = Math.max(1, data.sources.reduce((sum, item) => sum + item.clicks, 0));
  const sourceLabel = (source: "product" | "cart" | "credit") =>
    source === "product" ? "Карточка товара" : source === "credit" ? "Рассрочка" : "Корзина";

  mount.innerHTML = `
    <aside class="analytics__demoNote">
      <div><b><i></i>Демонстрационный режим</b><span>Цифры ниже — пример оформления. Реальные нажатия продолжают записываться отдельно.</span></div>
    </aside>
    <section class="analytics__kpis">
      <article><span>Нажатий «Купить»</span><strong>${data.summary.clicks}</strong><small>переходов в WhatsApp</small></article>
      <article class="analytics__kpiHero"><span>Товаров в запросах</span><strong>${data.summary.units}</strong><small>с учётом количества в корзине</small></article>
      <article><span>Посетителей</span><strong>${data.summary.visitors}</strong><small>уникальных покупателей</small></article>
      <article><span>Передано менеджеру</span><strong>${data.summary.handoffs || 0}</strong><small>диалогов, где менеджер подтвердил или отправил ответ</small></article>
    </section>

    <div class="analytics__grid">
      <section class="analytics__panel analytics__leaders">
        <header><div><p class="eyebrow">Рейтинг</p><h2>Товары-лидеры</h2></div><span>${data.topProducts.length} позиций</span></header>
        <div class="analytics__leaderList">
          ${data.topProducts.map((product, index) => `
            <article class="analytics__leader">
              <b class="analytics__rank">${String(index + 1).padStart(2, "0")}</b>
              <div class="analytics__leaderMain">
                <strong>${esc(product.productName)}</strong>
                <div class="analytics__track"><i style="width:${Math.max(6, product.clicks / maxProductClicks * 100)}%"></i></div>
              </div>
              <div class="analytics__leaderValue"><b>${product.clicks} нажатий</b><small>${product.units} шт. в запросах</small></div>
            </article>`).join("") || `<div class="analytics__empty">Пока нет переходов в WhatsApp. Статистика появится после первого нажатия «Купить».</div>`}
        </div>
      </section>

      <section class="analytics__panel analytics__trend">
        <header><div><p class="eyebrow">Динамика</p><h2>Нажатия по дням</h2></div></header>
        <div class="analytics__bars">
          ${data.trend.map((item) => `
            <div class="analytics__bar" title="${esc(item.day)} — ${item.clicks} нажатий">
              <b>${item.clicks}</b><i style="height:${Math.max(8, item.clicks / maxClicks * 100)}%"></i>
              <span>${new Date(`${item.day}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}</span>
            </div>`).join("") || `<div class="analytics__empty">Динамика появится после первого нажатия.</div>`}
        </div>
        <div class="analytics__sources">
          <p>Где нажимают «Купить»</p>
          ${data.sources.map((item) => `
            <div><span>${sourceLabel(item.source)}</span><i><b style="width:${item.clicks / sourceTotal * 100}%"></b></i><strong>${item.clicks}</strong></div>
          `).join("") || `<small>Источников пока нет</small>`}
        </div>
      </section>
    </div>

    <section class="analytics__panel analytics__recent">
      <header><div><p class="eyebrow">Журнал</p><h2>Последние переходы</h2></div></header>
      <div class="analytics__sales">
        ${data.recent.map((click) => {
          const totalQuantity = click.items.reduce((sum, item) => sum + item.quantity, 0);
          const names = click.items.map((item) => item.productName).join(", ");
          const details = click.items.map((item) => `${item.productName} × ${item.quantity}`).join(" · ");
          return `
          <article>
            <time>${esc(fmtRelative(click.clickedAt))}</time>
            <div><b>${esc(names)}</b><small>${esc(details)}</small></div>
            <span>${sourceLabel(click.source)}</span>
            <strong>${totalQuantity} шт.</strong>
          </article>`;
        }).join("") || `<div class="analytics__empty">Переходов за выбранный период пока нет.</div>`}
      </div>
    </section>`;
}

function wireAnalyticsView(): void {
  document.getElementById("analyticsDays")?.addEventListener("change", (event) => {
    state.analyticsDays = Number((event.target as HTMLSelectElement).value);
    renderAnalyticsMount();
  });
  renderAnalyticsMount();
}

// --- Подтверждение ответов бота ---------------------------------------

function renderApprovalsView(): string {
  return `
    <div class="admin__head">
      <div><p class="eyebrow">Human in the loop</p><h1 class="section__title">Ответы бота</h1>
        <p class="analytics__lead">Проверьте черновик, при необходимости отредактируйте и отправьте клиенту.</p></div>
      <label class="analytics__period">Показывать
        <select id="approvalFilter">
          <option value="pending" ${state.approvalFilter === "pending" ? "selected" : ""}>Ждут решения</option>
          <option value="all" ${state.approvalFilter === "all" ? "selected" : ""}>Все ответы</option>
        </select>
      </label>
    </div>
    <div class="bot-approvals" id="approvalsMount"><div class="crm__loading">Загружаем черновики…</div></div>`;
}

function renderApprovalsMount(): void {
  const mount = document.getElementById("approvalsMount");
  if (!mount) return;
  mount.innerHTML = state.approvals.map((item) => `
    <article class="bot-approval bot-approval--${item.status}">
      <header>
        <div><span class="crm__avatar">${esc(crmInitial(item.customerName))}</span>
          <div><b>${esc(item.customerName)}</b><small>${crmSourceLabel(item.source)} · ${esc(fmtRelative(item.createdAt))}</small></div>
        </div>
        <span class="bot-status">${item.status === "pending" ? "Ждёт решения" : item.status === "approved" ? "Отправлен" : "Отклонён"}</span>
      </header>
      <div class="bot-approval__message"><small>Сообщение клиента</small><p>${esc(item.customerMessage)}</p></div>
      ${item.summary ? `<div class="bot-approval__summary"><small>Гипервизор</small><p>${esc(item.summary)}</p></div>` : ""}
      ${item.rejectReason ? `<div class="bot-approval__summary"><small>Причина отклонения</small><p>${esc(item.rejectReason)}</p></div>` : ""}
      <label>Черновик ответа
        <textarea rows="5" data-approval-text="${item.id}" ${item.status !== "pending" ? "disabled" : ""}>${esc(item.editedReply || item.aiReply)}</textarea>
      </label>
      <footer>
        <small>${esc(item.model || "модель не указана")}</small>
        <button type="button" class="btn btn--ghost btn--sm" data-open-dialog="${item.conversationId}">Открыть диалог</button>
        ${item.status === "pending" ? `
          <button type="button" class="btn btn--ghost btn--sm" data-reject="${item.id}">Отклонить</button>
          <button type="button" class="btn btn--sm" data-approve="${item.id}">Подтвердить и отправить</button>` : ""}
      </footer>
    </article>`).join("") || `<div class="bot-empty">Новых ответов на подтверждение нет.</div>`;
}

async function loadApprovals(): Promise<void> {
  const result = await api<{ approvals: BotApproval[] }>("GET", `/crm/approvals?status=${state.approvalFilter}`);
  state.approvals = result.approvals;
  renderApprovalsMount();
  wireApprovalCards();
}

function wireApprovalCards(): void {
  document.querySelectorAll<HTMLElement>("[data-open-dialog]").forEach((button) => button.addEventListener("click", async () => {
    state.view = "crm";
    await loadCrmConversation(Number(button.dataset.openDialog));
    renderView();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-approve]").forEach((button) => button.addEventListener("click", async () => {
    const id = Number(button.dataset.approve);
    const text = (document.querySelector(`[data-approval-text="${id}"]`) as HTMLTextAreaElement).value;
    button.disabled = true;
    try {
      await api("POST", `/crm/approvals/${id}/approve`, { text });
      toast("Ответ отправлен клиенту");
      await loadApprovals();
    } catch (error) {
      toast((error as Error).message, false);
      button.disabled = false;
    }
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-reject]").forEach((button) => button.addEventListener("click", async () => {
    const reason = window.prompt("Почему ответ отклонён? Бот использует причину для обучения.");
    if (reason === null) return;
    if (!reason.trim()) {
      toast("Укажите причину отклонения", false);
      return;
    }
    button.disabled = true;
    try {
      await api("POST", `/crm/approvals/${button.dataset.reject}/reject`, { reason: reason.trim() });
      toast("Черновик отклонён");
      await loadApprovals();
    } catch (error) {
      toast((error as Error).message, false);
      button.disabled = false;
    }
  }));
}

function wireApprovalsView(): void {
  document.getElementById("approvalFilter")?.addEventListener("change", async (event) => {
    state.approvalFilter = (event.target as HTMLSelectElement).value as "pending" | "all";
    await loadApprovals();
  });
  loadApprovals().catch((error) => toast(error.message, false));
  crmPoll = setInterval(() => loadApprovals().catch(() => {}), 10000);
}

// --- Разработчикам: настройки, лаборатория и пайплайн -----------------

function promptValue(id: string): string {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value || "";
}

function currentBotSettings(): Partial<BotSettings> {
  return {
    approvalEnabled: Boolean((document.getElementById("botApproval") as HTMLInputElement | null)?.checked),
    aggressiveLearning: Boolean((document.getElementById("botAggressiveLearning") as HTMLInputElement | null)?.checked),
    model: (document.getElementById("botModel") as HTMLSelectElement | null)?.value,
    systemPrompt: promptValue("botSystemPrompt"),
    hypervisorPrompt: promptValue("botHypervisorPrompt"),
    characterPrompt: promptValue("botCharacterPrompt"),
    rulesPrompt: promptValue("botRulesPrompt"),
    taskPrompt: promptValue("botTaskPrompt"),
  };
}

function renderDeveloperView(): string {
  return `<div class="admin__head"><div><p class="eyebrow">Bot control center</p>
    <h1 class="section__title">Разработчикам</h1><p class="analytics__lead">Настройки модели, лаборатория и журнал прохождения сообщений.</p></div></div>
    <div id="developerMount"><div class="crm__loading">Проверяем системы бота…</div></div>`;
}

function renderLabMessages(): string {
  return state.labHistory.map((message) => `
    <article class="bot-lab__message bot-lab__message--${message.role}">
      <p>${esc(message.content).replace(/\n/g, "<br />")}</p>
      ${message.role === "assistant" ? `<small>${esc(message.model || "")} · ${message.latencyMs || 0} мс</small>` : ""}
    </article>`).join("") || `<div class="bot-empty">Напишите тестовый вопрос клиента — ответ останется только в лаборатории.</div>`;
}

function renderAiUsage(): string {
  const usage = state.aiUsage;
  if (!usage) return "";
  const periods: [keyof AiUsageAnalytics["periods"], string][] = [
    ["today", "Сегодня"],
    ["averageDay", "Средний в день"],
    ["month", "За месяц (30 дн.)"],
    ["year", "За год"],
    ["all", "За всё время"],
  ];
  const taskNames: Record<string, string> = {
    sales_agent: "Продавец-консультант",
    hypervisor_context: "Гипервизор · контекст",
    media_analysis: "Изображения и аудио",
    laboratory: "Лаборатория",
    aggressive_learning: "Агрессивное обучение",
  };
  return `
    <section class="bot-panel ai-usage">
      <header><div><p class="eyebrow">AI API</p><h2>Расход токенов по периодам</h2></div>
        <small>Стоимость рассчитана для DeepSeek; для ChatGPT и Gemini сохраняются токены.</small></header>
      <div class="ai-usage__periods">${periods.map(([key, label]) => `
        <article><strong>${fmtTokens(usage.periods[key].tokens)} <small>tok</small></strong>
          <b>${fmtUsd(usage.periods[key].costUsd)}</b><span>${label}</span></article>`).join("")}</div>
    </section>
    <section class="bot-panel ai-usage ai-usage--tasks">
      <header><div><p class="eyebrow">Пайплайн магазина</p><h2>Расход токенов по задачам ИИ</h2></div></header>
      <div class="ai-usage__table">
        <div class="ai-usage__row ai-usage__row--head"><span>Задача</span><span>Вызовов</span><span>Токенов</span><span>Стоимость</span></div>
        ${usage.tasks.map((item) => `<div class="ai-usage__row">
          <b>${esc(taskNames[item.task] || item.task)}<small>${esc(item.model)}</small></b>
          <span>${item.calls.toLocaleString("ru-RU")}</span>
          <span>${fmtTokens(item.tokens)}</span>
          <strong>${fmtUsd(item.costUsd)}</strong>
        </div>`).join("") || `<div class="bot-empty">Расходов пока нет. Первый реальный вызов ИИ появится здесь автоматически.</div>`}
      </div>
    </section>`;
}

function renderDeveloperMount(): void {
  const mount = document.getElementById("developerMount");
  const data = state.developerStatus;
  if (!mount || !data) return;
  const s = data.settings;
  mount.innerHTML = `
    <section class="bot-kpis">
      <article><span>ИИ</span><strong>${data.enabled ? "ONLINE" : "OFFLINE"}</strong></article>
      <article><span>Ждут подтверждения</span><strong>${data.approvals.pending}</strong></article>
      <article><span>Ошибок за 24 часа</span><strong>${data.errors24h}</strong></article>
    </section>
    <div class="bot-developer">
      <section class="bot-panel bot-settings">
        <header><div><p class="eyebrow">Конфигурация</p><h2>Настройки бота</h2></div>
          <button type="button" class="btn btn--sm" id="saveBotSettings">Сохранить</button></header>
        <label class="bot-switch"><input type="checkbox" id="botApproval" ${s.approvalEnabled ? "checked" : ""}><span></span>
          Подтверждать ответы перед отправкой</label>
        <label class="bot-switch bot-switch--learning"><input type="checkbox" id="botAggressiveLearning" ${s.aggressiveLearning ? "checked" : ""}><span></span>
          <div><b>Агрессивное обучение</b><small>После каждого отклонения сохраняет причину и точечно улучшает системный промпт.</small></div></label>
        <label>Модель<select id="botModel">${s.models.map((model) =>
          `<option value="${esc(model.id)}" ${model.id === s.model ? "selected" : ""} ${model.enabled ? "" : "disabled"}>
            ${esc(model.label)} · ${esc(model.provider)}${model.enabled ? "" : " — нужен API-ключ"}
          </option>`).join("")}</select></label>
        ${[
          ["botSystemPrompt", "Системный промпт", s.systemPrompt],
          ["botHypervisorPrompt", "Промпт гипервизора · только пересказ контекста", s.hypervisorPrompt],
          ["botCharacterPrompt", "Промпт характера", s.characterPrompt],
          ["botRulesPrompt", "Промпт правил", s.rulesPrompt],
          ["botTaskPrompt", "Промпт задачи", s.taskPrompt],
        ].map(([id, label, value]) => `<label>${label}<textarea id="${id}" rows="5">${esc(value)}</textarea></label>`).join("")}
      </section>
      <section class="bot-panel bot-lab">
        <header><div><p class="eyebrow">Изолировано от CRM и клиентов</p><h2>Лаборатория бота</h2>
          <small>Редактируйте промпты и проверяйте ответы — сообщения никуда не отправляются.</small></div>
          <button type="button" class="admin__link" id="clearBotLab">Очистить</button></header>
        <div class="bot-lab__messages" id="botLabMessages">${renderLabMessages()}</div>
        <form id="botLabForm"><textarea name="message" rows="3" placeholder="Сообщение тестового клиента…" required></textarea>
          <button class="btn btn--sm" type="submit">Запустить ↗</button></form>
      </section>
    </div>
    ${renderAiUsage()}
    <section class="bot-panel bot-pipeline">
      <header><div><p class="eyebrow">Live log</p><h2>Пайплайн и ошибки</h2></div>
        <button type="button" class="admin__link" id="refreshBotEvents">Обновить</button></header>
      <div class="bot-events">${state.botEvents.map((event) => `
        <article class="bot-event bot-event--${event.level}">
          <time>${esc(fmtRelative(event.createdAt))}</time><b>${esc(event.stage)}</b>
          <code>${esc(event.event)}</code><span>${esc(event.message || "")}</span>
        </article>`).join("") || `<div class="bot-empty">Событий пока нет.</div>`}</div>
    </section>`;
  wireDeveloperMount();
}

async function loadDeveloper(): Promise<void> {
  const [status, events, usage] = await Promise.all([
    api<DeveloperStatus>("GET", "/crm/developer/status"),
    api<{ events: BotEvent[] }>("GET", "/crm/developer/events?limit=150"),
    api<AiUsageAnalytics>("GET", "/crm/developer/usage"),
  ]);
  state.developerStatus = status;
  state.botEvents = events.events;
  state.aiUsage = usage;
  renderDeveloperMount();
}

function wireDeveloperMount(): void {
  document.getElementById("saveBotSettings")?.addEventListener("click", async () => {
    const saved = await api<BotSettings>("PUT", "/crm/settings", currentBotSettings());
    if (state.developerStatus) state.developerStatus.settings = saved;
    toast("Настройки бота сохранены");
  });
  document.getElementById("clearBotLab")?.addEventListener("click", () => {
    state.labHistory = [];
    const messages = document.getElementById("botLabMessages");
    if (messages) messages.innerHTML = renderLabMessages();
  });
  document.getElementById("refreshBotEvents")?.addEventListener("click", () => loadDeveloper().catch((error) => toast(error.message, false)));
  document.getElementById("botLabForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const field = form.elements.namedItem("message") as HTMLTextAreaElement;
    const message = field.value.trim();
    if (!message) return;
    const button = form.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    const history = state.labHistory.map(({ role, content }) => ({ role, content }));
    state.labHistory.push({ role: "user", content: message });
    field.value = "";
    const messages = document.getElementById("botLabMessages");
    if (messages) messages.innerHTML = renderLabMessages();
    try {
      const result = await api<{ reply: string; model: string; latencyMs: number }>("POST", "/crm/developer/lab", {
        message, history, model: currentBotSettings().model, prompts: currentBotSettings(),
      });
      state.labHistory.push({ role: "assistant", content: result.reply, model: result.model, latencyMs: result.latencyMs });
      if (messages) {
        messages.innerHTML = renderLabMessages();
        messages.scrollTop = messages.scrollHeight;
      }
    } catch (error) {
      toast((error as Error).message, false);
    } finally {
      button.disabled = false;
    }
  });
}

function wireDeveloperView(): void {
  loadDeveloper().catch((error) => toast(error.message, false));
}

// --- Общий каркас: вкладки + рендер ------------------------------------

const TABS: { id: AdminView; label: string }[] = [
  { id: "crm", label: "CRM" },
  { id: "approvals", label: "Ответы бота" },
  { id: "analytics", label: "Аналитика" },
  { id: "products", label: "Товары" },
  { id: "news", label: "Посты" },
  { id: "history", label: "Обновления" },
  { id: "developer", label: "Разработчикам" },
];

function tabsHTML(): string {
  return `<nav class="admin__tabs">
    <span class="admin__tabIndicator" aria-hidden="true"></span>
    ${TABS.map((t) => `<button type="button" class="admin__tab ${state.view === t.id ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
  </nav>`;
}

function syncTabIndicator(): void {
  const tabs = root.querySelector<HTMLElement>(".admin__tabs");
  const indicator = tabs?.querySelector<HTMLElement>(".admin__tabIndicator");
  const active = tabs?.querySelector<HTMLElement>(".admin__tab.active");
  if (!tabs || !indicator || !active) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft - tabs.clientLeft}px)`;
  requestAnimationFrame(() => tabs.classList.add("is-ready"));
}

function renderView(): void {
  if (crmPoll) {
    clearInterval(crmPoll);
    crmPoll = undefined;
  }
  if (!state.authenticated) return renderLogin();
  btnLogout.hidden = false;

  const body =
    state.view === "crm"
      ? renderCrmView()
      : state.view === "approvals"
        ? renderApprovalsView()
      : state.view === "developer"
        ? renderDeveloperView()
      : state.view === "analytics"
        ? renderAnalyticsView()
      : state.view === "news"
        ? renderNewsView()
        : state.view === "history"
          ? renderHistoryView()
          : renderProductsView();
  const currentTabs = root.querySelector<HTMLElement>(".admin__tabs");
  const currentView = root.querySelector<HTMLElement>(".admin__view");
  if (currentTabs && currentView) {
    currentView.innerHTML = body;
    currentTabs.querySelectorAll<HTMLElement>("[data-tab]").forEach((tab) =>
      tab.classList.toggle("active", tab.dataset.tab === state.view)
    );
  } else {
    root.innerHTML = tabsHTML() + `<div class="admin__view">${body}</div>`;
  }

  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => {
    if (b.dataset.wired === "true") return;
    b.dataset.wired = "true";
    b.addEventListener("click", () => {
      state.view = b.dataset.tab as AdminView;
      state.editingProductSlug = null;
      state.editingPostSlug = null;
      renderView();
    });
  });
  syncTabIndicator();

  if (state.view === "crm") wireCrmView();
  else if (state.view === "approvals") wireApprovalsView();
  else if (state.view === "developer") wireDeveloperView();
  else if (state.view === "analytics") wireAnalyticsView();
  else if (state.view === "news") wireNewsView();
  else if (state.view === "history") wireHistoryView();
  else wireProductsView();
}

btnLogout.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  state.authenticated = false;
  renderView();
});

(async function init() {
  await Promise.all([checkSession(), loadDisplayRates()]);
  renderView();
})();
