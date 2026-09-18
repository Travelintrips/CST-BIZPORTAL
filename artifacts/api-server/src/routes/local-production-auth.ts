import { randomInt } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { compare, hash } from "bcryptjs";
import { pool } from "@workspace/db";
import {
  getProductionUser,
  isDevelopmentEnvironment,
  setProductionSessionCookie,
  type ProductionSession,
} from "./dev-auth";

const router = Router();
const OTP_PURPOSE = "biz-login";
const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type RawUser = {
  id: string;
  email: string;
  role: string;
  passwordHash?: string | null;
};

function normalizePhone(value: string): string {
  let phone = value.replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("0")) phone = `62${phone.slice(1)}`;
  if (!phone.startsWith("62")) phone = `62${phone}`;
  return phone;
}

function createSession(user: { id: string; email: string }): ProductionSession {
  const issuedAt = Date.now();
  return {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_MS,
  };
}

async function findUserByEmail(email: string): Promise<RawUser | null> {
  const result = await pool.query<{ user_data: Record<string, unknown> }>(
    `select to_jsonb(u) as user_data
       from public.users u
      where lower(coalesce(to_jsonb(u)->>'email', '')) = $1
      limit 1`,
    [email],
  );
  const data = result.rows[0]?.user_data;
  if (!data || typeof data.id !== "string" || typeof data.email !== "string") return null;

  return {
    id: data.id,
    email: data.email,
    role: typeof data.role === "string" ? data.role : "",
    passwordHash: typeof data.password_hash === "string" ? data.password_hash : null,
  };
}

async function getFonnteToken(): Promise<string> {
  const environmentToken = process.env.FONNTE_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  try {
    const result = await pool.query<{ value: string }>(
      `select value
         from public.portal_content
        where key = 'fonnte_token'
          and trim(coalesce(value, '')) <> ''
        order by updated_at desc nulls last
        limit 1`,
    );
    return result.rows[0]?.value?.trim() ?? "";
  } catch {
    return "";
  }
}

async function sendWhatsAppOtp(phone: string, code: string, token: string): Promise<void> {
  const response = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      target: phone,
      message: [
        "🔐 Verifikasi Login",
        "",
        `Kode OTP Anda: ${code}`,
        "",
        "Kode berlaku selama 5 menit. Jangan bagikan kode ini kepada siapa pun.",
        "",
        "— PT Cahaya Sejati Teknologi",
      ].join("\n"),
    }).toString(),
  });

  const payload = await response.json().catch(() => null) as {
    status?: boolean | string;
    reason?: string;
    message?: string;
  } | null;
  const providerRejected = payload?.status === false || payload?.status === "false";
  if (!response.ok || providerRejected) {
    throw new Error(payload?.reason ?? payload?.message ?? `Fonnte returned ${response.status}`);
  }
}

async function issueOtp(phone: string): Promise<string> {
  const recent = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from public.wa_otp_codes
      where phone = $1
        and purpose = $2
        and created_at >= now() - interval '10 minutes'`,
    [phone, OTP_PURPOSE],
  );
  if (Number(recent.rows[0]?.count ?? 0) >= 3) {
    const error = new Error("Terlalu banyak permintaan OTP. Coba lagi nanti.");
    (error as Error & { statusCode?: number }).statusCode = 429;
    throw error;
  }

  const code = String(randomInt(100000, 1000000));
  const codeHash = await hash(code, 10);
  await pool.query(
    `insert into public.wa_otp_codes (phone, code_hash, purpose, expires_at)
     values ($1, $2, $3, $4)`,
    [phone, codeHash, OTP_PURPOSE, new Date(Date.now() + OTP_TTL_MS)],
  );
  return code;
}

async function getUserForPhone(phone: string): Promise<{ id: string; email: string } | null> {
  const localPhone = phone.startsWith("62") ? `0${phone.slice(2)}` : phone;
  const result = await pool.query<{ id: string; email: string }>(
    `select id, email
       from public.users
      where id = $1
         or regexp_replace(coalesce(whatsapp, ''), '\\D', '', 'g') in ($2, $3)
      order by case when id = $1 then 0 else 1 end
      limit 1`,
    [`wa_${phone}`, phone, localPhone],
  );
  return result.rows[0] ?? null;
}

router.post("/auth/email-login", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const email = typeof request.body?.email === "string"
    ? request.body.email.trim().toLowerCase()
    : "";
  const password = typeof request.body?.password === "string"
    ? request.body.password
    : "";

  if (!email || !email.includes("@") || !password) {
    response.status(400).json({ error: "Email dan password wajib diisi." });
    return;
  }

  try {
    const user = await findUserByEmail(email);
    if (!user?.passwordHash || !(await compare(password, user.passwordHash))) {
      response.status(401).json({ error: "Email atau password salah." });
      return;
    }

    const session = createSession(user);
    const localUser = await getProductionUser(session);
    if (!localUser) {
      response.status(403).json({ error: "Akun belum terdaftar di BizPortal." });
      return;
    }

    setProductionSessionCookie(response, session);
    response.json({ user: localUser });
  } catch (error) {
    request.log.error({ error }, "Local production email login failed");
    response.status(503).json({ error: "Layanan login belum tersedia." });
  }
});

router.post("/auth/wa-otp/send", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const rawPhone = typeof request.body?.phone === "string" ? request.body.phone : "";
  const phone = normalizePhone(rawPhone);
  if (!rawPhone || phone.length < 10) {
    response.status(400).json({ message: "Nomor HP tidak valid." });
    return;
  }

  try {
    const code = await issueOtp(phone);
    const token = await getFonnteToken();
    if (!token) {
      response.status(503).json({ message: "Layanan WhatsApp belum dikonfigurasi. Hubungi admin." });
      return;
    }

    await sendWhatsAppOtp(phone, code, token);
    response.json({ ok: true, phone });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    request.log.error({ error, phone }, "Local production WhatsApp OTP send failed");
    response.status(statusCode === 429 ? 429 : 502).json({
      message: statusCode === 429
        ? (error instanceof Error ? error.message : "Terlalu banyak permintaan OTP. Coba lagi nanti.")
        : "Gagal mengirim OTP via WhatsApp.",
    });
  }
});

router.post("/auth/wa-otp/verify", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const rawPhone = typeof request.body?.phone === "string" ? request.body.phone : "";
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  const phone = normalizePhone(rawPhone);
  if (!rawPhone || !code) {
    response.status(400).json({ message: "Nomor HP dan kode OTP diperlukan." });
    return;
  }

  try {
    const result = await pool.query<{
      id: number;
      code_hash: string;
      attempts: number;
      expires_at: Date;
    }>(
      `select id, code_hash, attempts, expires_at
         from public.wa_otp_codes
        where phone = $1
          and purpose = $2
          and verified = false
        order by created_at desc
        limit 1`,
      [phone, OTP_PURPOSE],
    );
    const otp = result.rows[0];
    if (!otp) {
      response.status(400).json({ message: "OTP tidak ditemukan. Minta OTP baru." });
      return;
    }
    if (new Date(otp.expires_at).getTime() <= Date.now()) {
      response.status(400).json({ message: "OTP kadaluarsa. Minta OTP baru." });
      return;
    }
    if (otp.attempts >= 5) {
      response.status(429).json({ message: "Terlalu banyak percobaan. Minta OTP baru." });
      return;
    }

    if (!(await compare(code, otp.code_hash))) {
      await pool.query(
        "update public.wa_otp_codes set attempts = attempts + 1 where id = $1",
        [otp.id],
      );
      response.status(400).json({ message: "Kode OTP salah." });
      return;
    }
    await pool.query("update public.wa_otp_codes set verified = true where id = $1", [otp.id]);

    let user = await getUserForPhone(phone);
    if (!user) {
      const created = await pool.query<{ id: string; email: string }>(
        `insert into public.users (id, email, name, role, whatsapp)
         values ($1, $2, $3, 'ecommerce', $4)
         on conflict (id) do update set updated_at = now()
         returning id, email`,
        [`wa_${phone}`, `${phone}@wa.local`, phone, phone],
      );
      user = created.rows[0] ?? null;
    }
    if (!user) {
      response.status(503).json({ message: "Akun WhatsApp belum dapat dibuat." });
      return;
    }

    const session = createSession(user);
    const localUser = await getProductionUser(session);
    if (!localUser) {
      response.status(403).json({ message: "Akun WhatsApp belum terdaftar di BizPortal." });
      return;
    }
    setProductionSessionCookie(response, session);
    response.json({ ok: true, user: localUser });
  } catch (error) {
    request.log.error({ error, phone }, "Local production WhatsApp OTP verification failed");
    response.status(503).json({ message: "Layanan verifikasi OTP belum tersedia." });
  }
});

export default router;