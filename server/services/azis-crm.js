const config = require("../config");

class AzisCrmClient {
  constructor({ baseUrl, secret, projectId, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl ?? config.azisCrm.baseUrl).replace(/\/+$/, "");
    this.secret = secret ?? config.azisCrm.integrationSecret;
    this.projectId = projectId ?? config.azisCrm.projectId;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.secret);
  }

  async publishEvent(type, payload) {
    if (!this.enabled) return { skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.azisCrm.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/integrations/mostovoy/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-integration-secret": this.secret,
          },
          body: JSON.stringify({ projectId: this.projectId || undefined, type, payload }),
          signal: controller.signal,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Azis CRM: HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { AzisCrmClient };
