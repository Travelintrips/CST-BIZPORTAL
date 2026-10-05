import { randomInt } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { compare, hash } from "bcryptjs";
import { pool } from "../lib/db";
import { sendAdminLoginOtpEmail } from "../lib/smtp";
import {
  getProductionSession,
  getProductionUser,
  initializeProductionSessionSigning,
  isDevelopmentEnvironment,
  setProductionSessionCookie,
  type ProductionSession,
} from "./dev-auth";

const router = Router();
const OTP_PURPOSE = "biz-login";
const EMAIL_OTP_PURPOSE = "admin-email-login";
const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const EMAIL_OTP_RATE_LIMIT = 3;

type RawUser = {
  id: string;
  email: string;
  role: string;
  status: string | null;
  isActive: boolean;
  firstName: string | null;
  lastName: string | null;
  companyId: number | null;
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

  const rawCompanyId = data.company_id ?? data.companyId;
  const parsedCompanyId = rawCompanyId == null ? null : Number(rawCompanyId);

  return {
    id: data.id,
    email: data.email,
    role: typeof data.role === "string" ? data.role : "",
    status: typeof data.status === "string"
      ? data.status
      : typeof data.user_status === "string"
        ? data.user_status
        : null,
    isActive: data.is_active === true || data.isActive === true,
    firstName: typeof data.first_name === "string" ? data.first_name : null,
    lastName: typeof data.last_name === "string" ? data.last_name : null,
    companyId:
      parsedCompanyId !== null
      && Number.isInteger(parsedCompanyId)
      && parsedCompanyId > 0
        ? parsedCompanyId
        : null,
    passwordHash: typeof data.password_hash === "string" ? data.password_hash : null,
  };
}

function isActivePrivilegedUser(user: RawUser | null): user is RawUser {
  if (!user) return false;
  const role = user.role.trim().toLowerCase();
  return Boolean(
    (role === "admin" || role === "owner")
    && user.isActive
    && (user.status === null || user.status.trim().toLowerCase() === "active"),
  );
}

async function getPrivilegedProductionUserFromRequest(request: Request): Promise<RawUser | null> {
  const session = getProductionSession(request);
  if (!session) return null;

  const user = await findUserByEmail(session.email);
  return isActivePrivilegedUser(user) ? user : null;
}

function getRequestIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (firstForwarded?.trim() || request.ip || "unknown").slice(0, 255);
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(value: string): boolean {
  return value.length > 3 && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function ensureEmailOtpTable(): Promise<void> {
  await pool.query(`
    create table if not exists public.bizportal_email_otp_codes (
      id bigserial primary key,
      email text not null,
      request_ip text not null,
      purpose text not null,
      code_hash text,
      attempts integer not null default 0,
      expires_at timestamptz not null,
      verified_at timestamptz,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create index if not exists bizportal_email_otp_rate_idx
      on public.bizportal_email_otp_codes (email, request_ip, created_at desc)
  `);
  await pool.query(`
    create index if not exists bizportal_email_otp_lookup_idx
      on public.bizportal_email_otp_codes (email, purpose, created_at desc)
  `);
}

async function countRecentEmailOtpRequests(email: string, requestIp: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from public.bizportal_email_otp_codes
      where purpose = $3
        and created_at >= now() - interval '10 minutes'
        and (email = $1 or request_ip = $2)`,
    [email, requestIp, EMAIL_OTP_PURPOSE],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function genericEmailOtpResponse(response: Response, status = 202): void {
  response.status(status).json({
    ok: true,
    message: "Jika email admin terdaftar, kode OTP akan dikirim.",
  });
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

    const normalizedRole = user.role.trim().toLowerCase();
    if (!user.isActive || !normalizedRole) {
      response.status(403).json({ error: "Akun belum terdaftar di BizPortal." });
      return;
    }

    await initializeProductionSessionSigning();

    const session = createSession(user);
    setProductionSessionCookie(response, session);
    response.json({
      user: {
        id: user.id,
        email: user.email.trim().toLowerCase(),
        firstName: user.firstName,
        lastName: user.lastName,
        role: normalizedRole,
        companyId: user.companyId,
      },
    });
  } catch (error) {
    request.log.error({ error }, "Local production email login failed");
    response.status(503).json({ error: "Layanan login belum tersedia." });
  }
});

router.get("/auth/admin/users-password-status", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  try {
    const actor = await getPrivilegedProductionUserFromRequest(request);
    if (!actor) {
      response.status(403).json({ error: "Admin/owner only" });
      return;
    }

    const result = await pool.query<{ user_data: Record<string, unknown> }>(
      `select to_jsonb(u) as user_data
         from public.users u
        order by lower(coalesce(to_jsonb(u)->>'email', ''))`,
    );

    const users = result.rows.flatMap(({ user_data: data }) => {
      const id = typeof data.id === "string" ? data.id : "";
      const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      if (!id || !email) return [];

      const firstName = typeof data.first_name === "string" ? data.first_name.trim() : "";
      const lastName = typeof data.last_name === "string" ? data.last_name.trim() : "";
      const fullName = [firstName, lastName].filter(Boolean).join(" ");
      const name = typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : fullName || email;

      return [{
        id,
        email,
        name,
        role: typeof data.role === "string" ? data.role.trim().toLowerCase() : "",
        hasPassword: typeof data.password_hash === "string" && data.password_hash.trim().length > 0,
      }];
    });

    response.json({ users });
  } catch (error) {
    request.log.error({ error }, "Local production password status failed");
    response.status(503).json({ error: "Layanan password belum tersedia." });
  }
});

router.post("/auth/admin/set-password", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const userId = typeof request.body?.userId === "string" ? request.body.userId.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!userId) {
    response.status(400).json({ error: "userId wajib diisi" });
    return;
  }
  if (password.length < 8) {
    response.status(400).json({ error: "Password minimal 8 karakter" });
    return;
  }

  try {
    const actor = await getPrivilegedProductionUserFromRequest(request);
    if (!actor) {
      response.status(403).json({ error: "Admin/owner only" });
      return;
    }

    const passwordHash = await hash(password, 12);
    const result = await pool.query<{ id: string; email: string }>(
      `update public.users
          set password_hash = $2,
              updated_at = now()
        where id = $1
        returning id, email`,
      [userId, passwordHash],
    );
    const updated = result.rows[0];
    if (!updated) {
      response.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    request.log.info(
      { actorEmail: actor.email, targetUserId: updated.id, targetEmail: updated.email },
      "Local production password updated",
    );
    response.json({ ok: true, email: updated.email });
  } catch (error) {
    request.log.error({ error }, "Local production set password failed");
    response.status(503).json({ error: "Gagal menyimpan password" });
  }
});

router.delete("/auth/admin/remove-password/:userId", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  try {
    const actor = await getPrivilegedProductionUserFromRequest(request);
    if (!actor) {
      response.status(403).json({ error: "Admin/owner only" });
      return;
    }

    const userId = String(request.params.userId ?? "").trim();
    if (!userId) {
      response.status(400).json({ error: "userId wajib diisi" });
      return;
    }

    const result = await pool.query<{ id: string; email: string }>(
      `update public.users
          set password_hash = null,
              updated_at = now()
        where id = $1
        returning id, email`,
      [userId],
    );
    const updated = result.rows[0];
    if (!updated) {
      response.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    request.log.info(
      { actorEmail: actor.email, targetUserId: updated.id, targetEmail: updated.email },
      "Local production password removed",
    );
    response.json({ ok: true, email: updated.email });
  } catch (error) {
    request.log.error({ error }, "Local production remove password failed");
    response.status(503).json({ error: "Gagal menghapus password" });
  }
});

router.post("/auth/email-otp/send", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const email = normalizeEmail(request.body?.email);
  if (!isValidEmail(email)) {
    response.status(400).json({ error: "Masukkan email admin yang valid." });
    return;
  }

  const requestIp = getRequestIp(request);
  try {
    await ensureEmailOtpTable();
    if (await countRecentEmailOtpRequests(email, requestIp) >= EMAIL_OTP_RATE_LIMIT) {
      response.setHeader("Retry-After", "600");
      genericEmailOtpResponse(response);
      return;
    }

    const user = await findUserByEmail(email);
    if (!isActivePrivilegedUser(user)) {
      await pool.query(
        `insert into public.bizportal_email_otp_codes
          (email, request_ip, purpose, expires_at)
         values ($1, $2, $3, $4)`,
        [email, requestIp, EMAIL_OTP_PURPOSE, new Date(Date.now() + OTP_TTL_MS)],
      );
      genericEmailOtpResponse(response);
      return;
    }

    const code = String(randomInt(100000, 1000000));
    const codeHash = await hash(code, 10);
    const inserted = await pool.query<{ id: string }>(
      `with invalidated as (
         update public.bizportal_email_otp_codes
            set verified_at = now()
          where email = $1
            and purpose = $2
            and verified_at is null
       )
       insert into public.bizportal_email_otp_codes
         (email, request_ip, purpose, code_hash, expires_at)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [email, requestIp, EMAIL_OTP_PURPOSE, codeHash, new Date(Date.now() + OTP_TTL_MS)],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Email OTP record was not created");

    try {
      await sendAdminLoginOtpEmail(email, code);
    } catch (error) {
      request.log.error({ error, email }, "Admin email OTP delivery failed");
      const diagnostic = {
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : "Unknown SMTP delivery failure",
      };
      await pool.query(
        `insert into public.audit_logs
          (user_email, action, entity_type, entity_id, after_data, ip_address, company_id, module)
         values ($1, 'email_otp_delivery_failed', 'auth', $2, $3::jsonb, $4, 'default', 'system')`,
        [email, id, JSON.stringify(diagnostic), requestIp],
      ).catch(() => undefined);
      await pool.query(
        "delete from public.bizportal_email_otp_codes where id = $1 and verified_at is null",
        [id],
      ).catch(() => undefined);
    }

    genericEmailOtpResponse(response);
  } catch {
    request.log.error({ route: "email-otp-send" }, "Local email OTP request failed");
    genericEmailOtpResponse(response);
  }
});

router.post("/auth/email-otp/verify", async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  if (isDevelopmentEnvironment()) {
    next();
    return;
  }

  const email = normalizeEmail(request.body?.email);
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
    return;
  }

  try {
    await ensureEmailOtpTable();
    const result = await pool.query<{
      id: string;
      code_hash: string;
      attempts: number;
      expires_at: Date;
    }>(
      `select id, code_hash, attempts, expires_at
         from public.bizportal_email_otp_codes
        where email = $1
          and purpose = $2
          and code_hash is not null
          and verified_at is null
        order by created_at desc
        limit 1`,
      [email, EMAIL_OTP_PURPOSE],
    );
    const otp = result.rows[0];
    if (!otp) {
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }
    if (new Date(otp.expires_at).getTime() <= Date.now()) {
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }
    if (otp.attempts >= 5) {
      response.status(429).json({ error: "Terlalu banyak percobaan. Minta OTP baru." });
      return;
    }

    if (!(await compare(code, otp.code_hash))) {
      await pool.query(
        `update public.bizportal_email_otp_codes
            set attempts = attempts + 1
          where id = $1
            and verified_at is null
            and attempts < 5`,
        [otp.id],
      );
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }

    const user = await findUserByEmail(email);
    if (!isActivePrivilegedUser(user)) {
      await pool.query(
        "update public.bizportal_email_otp_codes set verified_at = now() where id = $1 and verified_at is null",
        [otp.id],
      );
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }

    const consumed = await pool.query(
      `update public.bizportal_email_otp_codes
          set verified_at = now()
        where id = $1
          and verified_at is null
          and attempts < 5
        returning id`,
      [otp.id],
    );
    if (consumed.rowCount !== 1) {
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }

    const session = createSession(user);
    const localUser = await getProductionUser(session);
    if (
      !localUser
      || !["admin", "owner"].includes(localUser.role.trim().toLowerCase())
    ) {
      response.status(400).json({ error: "Email atau kode OTP tidak dapat digunakan." });
      return;
    }

    await initializeProductionSessionSigning();
    setProductionSessionCookie(response, session);
    response.json({ ok: true, user: localUser });
  } catch {
    request.log.error({ route: "email-otp-verify" }, "Local email OTP verification failed");
    response.status(503).json({ error: "Layanan verifikasi OTP belum tersedia." });
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