// Быстрое добавление товара по ссылке: вставил URL страницы товара у
// поставщика → сервер сам вытащил название/фото/цену (Open Graph / JSON-LD)
// → админ проверяет и жмёт «Сохранить». Для сложных случаев (свотчи,
// скидки, несколько фото) — обычная CRM (admin.html), эта страница не
// пытается её заменить, только ускоряет самый частый случай.
import "./styles.css";
import { optimizedImageUrl } from "./image-url";

interface Draft {
  name: string;
  image: string;
  price: number | null;
  currency: string | null;
  sourceUrl: string;
}

const root = document.getElementById("quickAdd")!;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let toastTimer: ReturnType<typeof setTimeout>;
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

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Ошибка ${res.status}`);
  return data as T;
}

function renderLoggedOut(): void {
  root.innerHTML = `
    <div class="admin__login">
      <div class="admin__login-brand">
        <span class="logo__badge admin__login-badge" role="img" aria-label="Мостовой"></span>
        <span class="admin__login-kicker">Быстрое добавление</span>
      </div>
      <p class="admin__login-copy">Сначала войдите в CRM — сессия там же и здесь.</p>
      <a class="btn" href="admin.html">Войти в CRM</a>
    </div>`;
}

function renderForm(): void {
  root.innerHTML = `
    <div class="admin__login-brand" style="margin-bottom:18px">
      <span class="logo__badge admin__login-badge" role="img" aria-label="Мостовой"></span>
      <span class="admin__login-kicker">Быстрое добавление товара</span>
    </div>

    <form id="urlForm" class="calc__row2" style="align-items:end">
      <label style="grid-column:1/-1">Ссылка на товар у поставщика
        <input name="url" type="url" required placeholder="https://softech.kg/..." />
      </label>
      <button type="submit" class="btn" id="btnFind">Найти</button>
    </form>

    <div id="draftBox"></div>`;

  document.getElementById("urlForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const url = (form.elements.namedItem("url") as HTMLInputElement).value.trim();
    if (!url) return;
    const btn = document.getElementById("btnFind") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Ищу…";
    try {
      const draft = await api<Draft>("POST", "/import-url", { url });
      renderDraft(draft);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Не удалось разобрать страницу", false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Найти";
    }
  });
}

function renderDraft(draft: Draft): void {
  const box = document.getElementById("draftBox")!;
  box.innerHTML = `
    <form id="draftForm" class="admin__block" style="margin-top:20px">
      <div class="calc__row2">
        <div>
          ${draft.image ? `<img src="${esc(optimizedImageUrl(draft.image, 320))}" alt="" style="width:100%;max-width:280px;border-radius:12px;object-fit:contain;background:#f4f4f6" />` : `<p class="admin__login-copy">Фото не нашли — вставьте ссылку на фото вручную ниже.</p>`}
          <label style="margin-top:10px;display:block">Фото — URL
            <input name="image" value="${esc(draft.image)}" placeholder="https://..." />
          </label>
        </div>
        <div>
          <label>Название *
            <input name="name" required value="${esc(draft.name)}" />
          </label>
          <div class="calc__row2">
            <label>Цена *
              <input name="price" type="number" min="0" step="0.01" required value="${draft.price ?? ""}" />
            </label>
            <label>Валюта
              <select name="currency">
                ${["USD", "KGS", "RUB"].map((c) => `<option value="${c}" ${draft.currency === c ? "selected" : ""}>${c}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="calc__row2">
            <label>Бренд
              <input name="brand" placeholder="Apple" />
            </label>
            <label>Категория
              <input name="category" placeholder="Смартфоны" />
            </label>
          </div>
        </div>
      </div>
      <p class="admin__login-copy">Источник: <a href="${esc(draft.sourceUrl)}" target="_blank" rel="noopener">${esc(draft.sourceUrl)}</a></p>
      <button type="submit" class="btn" id="btnSave">Сохранить товар</button>
    </form>`;

  document.getElementById("draftForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const btn = document.getElementById("btnSave") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Сохраняю…";
    try {
      await api("POST", "/products", {
        name: fd.get("name"),
        price: Number(fd.get("price")),
        currency: fd.get("currency"),
        brand: fd.get("brand") || null,
        category: fd.get("category") || null,
        image: fd.get("image") || undefined,
      });
      toast("Товар добавлен");
      renderForm();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Не удалось сохранить", false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить товар";
    }
  });
}

(async () => {
  const session = await fetch("/api/admin/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .catch(() => ({ authenticated: false, loginEnabled: true }));
  if (session.loginEnabled && !session.authenticated) {
    renderLoggedOut();
    return;
  }
  renderForm();
})();
