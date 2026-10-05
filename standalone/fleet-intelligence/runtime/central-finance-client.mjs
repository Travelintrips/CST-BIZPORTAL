const required = (value, name) => {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};

export function createCentralFinanceClient(env = process.env, fetchImpl = fetch) {
  const baseUrl = required(env.CENTRAL_FINANCE_BASE_URL, "CENTRAL_FINANCE_BASE_URL").replace(/\/$/, "");
  const token = required(env.CENTRAL_FINANCE_SERVICE_TOKEN, "CENTRAL_FINANCE_SERVICE_TOKEN");
  const writeEnabled = String(env.CENTRAL_FINANCE_WRITE_ENABLED ?? "false").toLowerCase() === "true";

  async function request(path, init = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(`Central Finance request failed: ${detail}`);
    }
    return payload;
  }

  return {
    getFleetAccountingSettings(companyId) {
      return request(`/api/integrations/fleet/companies/${encodeURIComponent(companyId)}/accounting-settings`);
    },

    async postFleetCashPayment({ companyId, paymentId, idempotencyKey, payload }) {
      if (!writeEnabled) throw new Error("Central Finance writes are disabled for Fleet.");
      required(idempotencyKey, "idempotencyKey");
      return request("/api/integrations/fleet/cash-payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ companyId, paymentId, ...payload }),
      });
    },

    async reverseFleetCashPayment({ companyId, paymentId, idempotencyKey, reason }) {
      if (!writeEnabled) throw new Error("Central Finance writes are disabled for Fleet.");
      required(idempotencyKey, "idempotencyKey");
      required(reason, "reason");
      return request("/api/integrations/fleet/cash-payments/reverse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ companyId, paymentId, reason }),
      });
    },
  };
}
