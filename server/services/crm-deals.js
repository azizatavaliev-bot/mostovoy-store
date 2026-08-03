// Сделки в MostovoyCRM (Next.js + Supabase).
//
// Витрина только сообщает «пришёл новый клиент» — воронку ведёт CRM.
// Вызов всегда fire-and-forget: если CRM лежит, бот всё равно отвечает
// клиенту без задержки, а пропущенные сделки CRM добирает сама, сверяясь
// с GET /api/admin/crm/conversations (кнопка «Синхронизировать»).

const config = require("../config");

// В воронке CRM нет канала «amocrm»: через amoCRM к нам приходят WhatsApp и
// Instagram, а неопознанный origin у этого магазина — это WhatsApp.
const SOURCE_MAP = {
  telegram: "telegram",
  whatsapp: "whatsapp",
  instagram: "instagram",
};

class CrmDealsClient {
  constructor({ baseUrl, internalToken, timeoutMs, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl ?? config.crmDeals.baseUrl).replace(/\/+$/, "");
    this.internalToken = internalToken ?? config.crmDeals.internalToken;
    this.timeoutMs = timeoutMs ?? config.crmDeals.timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.internalToken);
  }

  async createDeal({ externalKey, source, customerName, customerPhone, customerUsername }) {
    if (!this.enabled) return { skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/internal/deals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.internalToken,
        },
        body: JSON.stringify({
          externalKey,
          source: SOURCE_MAP[source] || "whatsapp",
          customerName: customerName || null,
          customerPhone: customerPhone || null,
          customerUsername: customerUsername || null,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `CRM: HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async advanceToPrimaryContact({ externalKey }) {
    if (!this.enabled) return { skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/internal/deals`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.internalToken,
        },
        body: JSON.stringify({ externalKey, action: "primary_contact" }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `CRM: HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async createOrder({ externalKey, productName, amount, currency, orderType, customerName, customerPhone, note }) {
    if (!this.enabled) return { skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/internal/deals`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.internalToken,
        },
        body: JSON.stringify({
          action: "order",
          externalKey,
          productName,
          amount: amount ?? null,
          currency: currency || "KGS",
          orderType: orderType || "standard",
          customerName: customerName || null,
          customerPhone: customerPhone || null,
          note: note || null,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `CRM: HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { CrmDealsClient };
