import net from "node:net";
import tls from "node:tls";
import { getDatabaseSecretName, readSecret } from "@workspace/db";

type SmtpSocket = net.Socket | tls.TLSSocket;

class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

let managedSmtpConfigPromise: Promise<Record<string, string>> | null = null;

function isProductionRuntime(): boolean {
  const environment = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  return environment === "production";
}

function extractMailboxAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.match(/<([^<>@\s]+@[^<>@\s]+)>/)?.[1]
    ?? value.match(/^([^<>@\s]+@[^<>@\s]+)$/)?.[1];
}

async function readManagedSmtpConfig(): Promise<Record<string, string>> {
  if (!managedSmtpConfigPromise) {
    managedSmtpConfigPromise = (async () => {
      let raw: string;
      try {
        raw = await readSecret(getDatabaseSecretName(isProductionRuntime()));
      } catch {
        throw new SmtpError("Managed SMTP configuration is unavailable");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new SmtpError("Managed SMTP configuration is invalid");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SmtpError("Managed SMTP configuration is invalid");
      }

      const source = parsed as Record<string, unknown>;
      const resolved: Record<string, string> = {};
      for (const key of [
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USER",
        "SMTP_PASS",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "SMTP_SECURE",
      ]) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) {
          resolved[key] = value.trim();
        }
      }
      return resolved;
    })().catch((error) => {
      managedSmtpConfigPromise = null;
      throw error;
    });
  }
  return managedSmtpConfigPromise;
}

export async function resolveSmtpConfig() {
  let configuredHost = process.env.SMTP_HOST?.trim();
  let configuredPort = process.env.SMTP_PORT?.trim();
  let configuredUser = process.env.SMTP_USER?.trim();
  let password = (process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD)?.trim();
  let configuredFrom = process.env.SMTP_FROM?.trim();
  let configuredSecure = process.env.SMTP_SECURE?.trim();

  const directFallbackAddress = extractMailboxAddress(configuredFrom);
  const hasDirectCoreConfig = Boolean(
    configuredFrom
    && password
    && (configuredUser || directFallbackAddress),
  );

  const source = hasDirectCoreConfig ? "environment" : "managed-secret";

  if (!hasDirectCoreConfig) {
    const managed = await readManagedSmtpConfig();
    configuredHost ||= managed.SMTP_HOST;
    configuredPort ||= managed.SMTP_PORT;
    configuredUser ||= managed.SMTP_USER;
    password ||= managed.SMTP_PASS || managed.SMTP_PASSWORD;
    configuredFrom ||= managed.SMTP_FROM;
    configuredSecure ||= managed.SMTP_SECURE;
  }

  const fallbackAddress = extractMailboxAddress(configuredFrom);

  // The standalone Hostinger deployment historically only required
  // SMTP_FROM + SMTP_PASS. Preserve that deployment contract while still
  // allowing every SMTP setting to be overridden explicitly.
  const host = configuredHost || "smtp.hostinger.com";
  const portValue = configuredPort || (configuredHost ? "587" : "465");
  const port = Number(portValue);
  const user = configuredUser || fallbackAddress;
  const from = configuredFrom || user;
  const secure = configuredSecure?.toLowerCase() === "true" || port === 465;

  if (!Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !from) {
    throw new SmtpError("SMTP email configuration is incomplete");
  }

  if (/[^\x20-\x7e]/.test(from) || /[\r\n]/.test(from)) {
    throw new SmtpError("SMTP sender configuration is invalid");
  }

  const addressMatch = extractMailboxAddress(from);
  if (!addressMatch) {
    throw new SmtpError("SMTP sender address is invalid");
  }

  return { host, port, user, password, from, envelopeFrom: addressMatch, secure, source };
}

function validateAddress(value: string): string {
  if (/[\r\n]/.test(value)) throw new SmtpError("SMTP address is invalid");
  const match = value.match(/^([^<>@\s]+@[^<>@\s]+)$/);
  if (!match) throw new SmtpError("SMTP address is invalid");
  return match[1];
}

function waitForResponse(socket: SmtpSocket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const match = line.match(/^(\d{3})([ -])(.*)$/);
        if (!match) continue;
        if (match[2] === " ") {
          const code = Number(match[1]);
          finish(() => resolve({ code, text: line }));
          return;
        }
      }
    };

    const onError = () => finish(() => reject(new SmtpError("SMTP connection failed")));
    const onClose = () => finish(() => reject(new SmtpError("SMTP connection closed unexpectedly")));

    timer = setTimeout(() => finish(() => reject(new SmtpError("SMTP response timed out"))), 15_000);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function command(socket: SmtpSocket, value: string, expected: number | number[]): Promise<string> {
  socket.write(`${value}\r\n`);
  const response = await waitForResponse(socket);
  const accepted = Array.isArray(expected) ? expected.includes(response.code) : response.code === expected;
  if (!accepted) throw new SmtpError(`SMTP command rejected (${response.code})`);
  return response.text;
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const onError = () => {
      socket.destroy();
      reject(new SmtpError("SMTP connection failed"));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function upgradeToTls(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: host });
    const onError = () => {
      secureSocket.destroy();
      reject(new SmtpError("SMTP TLS negotiation failed"));
    };
    secureSocket.once("error", onError);
    secureSocket.once("secureConnect", () => {
      secureSocket.off("error", onError);
      resolve(secureSocket);
    });
  });
}

function dotStuff(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export async function sendAdminLoginOtpEmail(recipient: string, code: string): Promise<void> {
  const config = await resolveSmtpConfig();
  const safeRecipient = validateAddress(recipient);
  if (!/^\d{6}$/.test(code)) throw new SmtpError("OTP format is invalid");

  let socket: SmtpSocket | null = null;
  try {
    socket = config.secure
      ? await new Promise<tls.TLSSocket>((resolve, reject) => {
          const secureSocket = tls.connect({ host: config.host, port: config.port, servername: config.host });
          const onError = () => {
            secureSocket.destroy();
            reject(new SmtpError("SMTP TLS connection failed"));
          };
          secureSocket.once("error", onError);
          secureSocket.once("secureConnect", () => {
            secureSocket.off("error", onError);
            resolve(secureSocket);
          });
        })
      : await connectPlain(config.host, config.port);

    await waitForResponse(socket);
    let ehlo = await command(socket, `EHLO bizportal.cstlogistic.co.id`, 250);
    if (!config.secure) {
      if (!/STARTTLS/i.test(ehlo)) throw new SmtpError("SMTP server does not offer STARTTLS");
      await command(socket, "STARTTLS", 220);
      socket = await upgradeToTls(socket as net.Socket, config.host);
      ehlo = await command(socket, `EHLO bizportal.cstlogistic.co.id`, 250);
    }

    if (!/AUTH/i.test(ehlo)) throw new SmtpError("SMTP server does not offer authentication");
    await command(socket, "AUTH LOGIN", 334);
    await command(socket, Buffer.from(config.user).toString("base64"), 334);
    await command(socket, Buffer.from(config.password).toString("base64"), 235);
    await command(socket, `MAIL FROM:<${config.envelopeFrom}>`, 250);
    await command(socket, `RCPT TO:<${safeRecipient}>`, [250, 251]);
    await command(socket, "DATA", 354);

    const message = [
      `From: ${config.from}`,
      `To: ${safeRecipient}`,
      "Subject: Kode OTP Login BizPortal",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Kode OTP Login BizPortal",
      "",
      `Kode Anda: ${code}`,
      "Kode ini berlaku selama 5 menit dan hanya dapat digunakan satu kali.",
      "Jangan bagikan kode ini kepada siapa pun.",
      "",
      "Jika Anda tidak meminta kode ini, abaikan email ini.",
    ].join("\r\n");
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    await waitForResponse(socket).then((response) => {
      if (response.code !== 250) throw new SmtpError(`SMTP message rejected (${response.code})`);
    });
    await command(socket, "QUIT", 221).catch(() => undefined);
  } finally {
    socket?.end();
  }
}