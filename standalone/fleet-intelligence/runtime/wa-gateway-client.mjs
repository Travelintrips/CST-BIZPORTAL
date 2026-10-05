const required = (value, name) => {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  return "62" + digits;
};

export function createFleetWaGatewayClient(env = process.env, fetchImpl = fetch) {
  const baseUrl = required(env.CST_WA_GATEWAY_URL || env.WA_GATEWAY_URL, "CST_WA_GATEWAY_URL").replace(/\/$/, "");
  const token = required(env.CST_WA_GATEWAY_TOKEN || env.WA_GATEWAY_TOKEN, "CST_WA_GATEWAY_TOKEN");
  const deviceId = String(env.FLEET_WA_DEVICE_ID ?? "").trim();

  return {
    async send({ phone, message, idempotencyKey }) {
      const target = normalizePhone(phone);
      if (!target) throw new Error("Fleet WA target phone is invalid.");
      if (!String(message ?? "").trim()) throw new Error("Fleet WA message is empty.");

      const response = await fetchImpl(`${baseUrl}/api/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          to: target,
          message: String(message),
          ...(deviceId ? { deviceId } : {}),
          source: "fleet-intelligence",
        }),
        signal: AbortSignal.timeout(15000),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? payload?.message ?? `WA Gateway returned ${response.status}`);
      }
      return payload;
    },
  };
}
