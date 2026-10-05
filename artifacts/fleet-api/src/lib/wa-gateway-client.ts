function required(value: unknown, name: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} belum dikonfigurasi.`);
  return v;
}

export function normalizeFleetPhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  return "62" + digits;
}

export async function sendFleetWa(args: { phone: string; message: string; idempotencyKey?: string }) {
  const baseUrl = required(process.env.CST_WA_GATEWAY_URL ?? process.env.WA_GATEWAY_URL, "CST_WA_GATEWAY_URL").replace(/\/$/, "");
  const token = required(process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN, "CST_WA_GATEWAY_TOKEN");
  const phone = normalizeFleetPhone(args.phone);
  if (!phone) throw new Error("Nomor WhatsApp Fleet tidak valid.");
  const deviceId = String(process.env.FLEET_WA_DEVICE_ID ?? "").trim();

  const response = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      to: phone,
      message: args.message,
      source: "fleet-intelligence",
      ...(deviceId ? { deviceId } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? payload.message ?? `WA Gateway HTTP ${response.status}`));
  return {
    messageId: String(payload.messageId ?? payload.id ?? payload.requestId ?? "") || null,
    senderDevice: deviceId || null,
    deviceStatus: String(payload.status ?? "") || null,
  };
}
