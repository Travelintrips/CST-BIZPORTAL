import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";
import {
  importGmailInvoiceCandidate,
  listGmailInvoiceCandidates,
  reviewGmailInvoiceCandidate,
  syncGmailInvoiceCandidates,
} from "../lib/gmail-invoice-candidates";
import { getRuntimeConfig } from "../lib/gmail-invoice-runtime";
import {
  listGmailOrganizationRules,
  provisionGmailOrganizationRules,
} from "../lib/gmail-organization";

const router = Router();
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
] as const;
const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");
const DEFAULT_SOURCE_EMAIL = "travelincars01@gmail.com";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

type GmailSourceStatus = {
  oauthConfigured: boolean;
  aiConfigured: boolean;
  expectedEmail: string;
  connected: boolean;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncStatus: string | null;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  redirectUri: string;
  scope: string;
  organizerRuleCount: number;
  organizerActiveCount: number;
  organizerErrorCount: number;
};

type SignedState = {
  companyId: number;
  actorEmail: string;
  returnPath: string;
  issuedAt: number;
  nonce: string;
};

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireCompanyScope(
  response: Response,
  actor: DevAuthUser,
  value: unknown,
): number | null {
  const companyId = parsePositiveInt(value);
  if (!companyId) {
    response.status(400).json({ error: "company_id wajib" });
    return null;
  }

  if (actor.companyId != null && actor.companyId !== companyId) {
    response.status(403).json({
      error: "Perusahaan yang dipilih tidak sesuai dengan akses pengguna.",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
    return null;
  }

  return companyId;
}

function sourceEmail(): string {
  return (
    process.env.GMAIL_INVOICE_SOURCE_EMAIL ||
    DEFAULT_SOURCE_EMAIL
  )
    .trim()
    .toLowerCase();
}

async function googleClientId(): Promise<string> {
  return (
    (await getRuntimeConfig("GMAIL_GOOGLE_CLIENT_ID")) ||
    (await getRuntimeConfig("GOOGLE_CLIENT_ID"))
  );
}

async function googleClientSecret(): Promise<string> {
  return (
    (await getRuntimeConfig("GMAIL_GOOGLE_CLIENT_SECRET")) ||
    (await getRuntimeConfig("GOOGLE_CLIENT_SECRET"))
  );
}

function safeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/finance/recon-config?tab=invoice-sources";
  }
  return value;
}

function getRedirectUri(request: Request): string {
  const configured =
    process.env.GMAIL_INVOICE_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;

  const forwardedProto = String(
    request.headers["x-forwarded-proto"] ?? "",
  )
    .split(",")[0]
    .trim();

  const protocol =
    forwardedProto || request.protocol || "https";

  const forwardedHost = String(
    request.headers["x-forwarded-host"] ?? "",
  )
    .split(",")[0]
    .trim();

  const host = forwardedHost || request.get("host");
  if (!host) {
    throw new Error("Unable to determine public BizPortal host");
  }

  return `${protocol}://${host}/api/recon-classification/invoice-sources/gmail/callback`;
}

async function getActor(
  request: Request,
): Promise<DevAuthUser | null> {
  if (isDevelopmentEnvironment()) {
    return getDevSession(request);
  }

  const session = getProductionSession(request);
  if (!session) return null;
  return getProductionUser(session);
}

async function requireFinanceAdmin(
  request: Request,
): Promise<DevAuthUser | null> {
  const actor = await getActor(request);
  if (!actor) return null;

  const role = actor.role.trim().toLowerCase();
  return ["admin", "owner", "super_admin"].includes(role)
    ? actor
    : null;
}

function configPrefix(companyId: number): string {
  return `GMAIL_INVOICE_SOURCE_${companyId}_`;
}

async function getConfig(
  companyId: number,
  suffix: string,
): Promise<string | null> {
  const key = `${configPrefix(companyId)}${suffix}`;
  const result = await pool.query<{ value: string | null }>(
    "select value from public.app_config where key=$1 limit 1",
    [key],
  );
  return result.rows[0]?.value ?? null;
}

async function setConfig(
  companyId: number,
  suffix: string,
  value: string | null,
  options: {
    secret?: boolean;
    description?: string;
    actor?: string;
  } = {},
): Promise<void> {
  const key = `${configPrefix(companyId)}${suffix}`;

  await pool.query(
    `insert into public.app_config(
       key,value,is_secret,description,environment,updated_at,updated_by
     )
     values($1,$2,$3,$4,'production',now(),$5)
     on conflict(key) do update set
       value=excluded.value,
       is_secret=excluded.is_secret,
       description=excluded.description,
       updated_at=now(),
       updated_by=excluded.updated_by`,
    [
      key,
      value,
      options.secret ?? false,
      options.description ?? null,
      options.actor ?? null,
    ],
  );
}

async function encryptionKey(): Promise<Buffer> {
  const secret = await googleClientSecret();
  if (!secret) {
    throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  }

  return crypto
    .createHash("sha256")
    .update("cst-bizportal:gmail-invoice-source:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

async function encryptRefreshToken(
  refreshToken: string,
): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    iv,
  );

  const encrypted = Buffer.concat([
    cipher.update(refreshToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

async function decryptRefreshToken(
  value: string,
): Promise<string> {
  const [version, ivRaw, tagRaw, encryptedRaw] =
    value.split(".");

  if (
    version !== "v1" ||
    !ivRaw ||
    !tagRaw ||
    !encryptedRaw
  ) {
    throw new Error(
      "Stored Gmail refresh token has an unsupported format",
    );
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );

  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function stateSecret(): Promise<string> {
  const secret = await googleClientSecret();
  if (!secret) {
    throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  }

  return crypto
    .createHash("sha256")
    .update("cst-bizportal:gmail-oauth-state:v1\0", "utf8")
    .update(secret, "utf8")
    .digest("base64url");
}

async function signState(
  payload: SignedState,
): Promise<string> {
  const encoded = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", await stateSecret())
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

async function parseState(
  raw: unknown,
): Promise<SignedState | null> {
  if (typeof raw !== "string") return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = raw.slice(0, separator);
  const suppliedSignature = raw.slice(separator + 1);

  const expectedSignature = crypto
    .createHmac("sha256", await stateSecret())
    .update(encoded)
    .digest("base64url");

  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expectedSignature);

  if (
    left.length !== right.length ||
    !crypto.timingSafeEqual(left, right)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SignedState;

    if (
      !parsePositiveInt(parsed.companyId) ||
      typeof parsed.actorEmail !== "string" ||
      typeof parsed.returnPath !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.nonce !== "string" ||
      Date.now() - parsed.issuedAt > STATE_MAX_AGE_MS ||
      parsed.issuedAt > Date.now() + 60_000
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function redirectWithResult(
  response: Response,
  returnPath: string,
  params: Record<string, string>,
): void {
  const target = new URL(
    safeReturnPath(returnPath),
    "https://bizportal.local",
  );

  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }

  response.redirect(
    303,
    `${target.pathname}${target.search}`,
  );
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
}> {
  const [clientId, clientSecret] = await Promise.all([
    googleClientId(),
    googleClientSecret(),
  ]);

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    },
  );

  const payload = (await response.json()) as Record<
    string,
    unknown
  >;

  if (
    !response.ok ||
    typeof payload.access_token !== "string"
  ) {
    throw new Error(
      typeof payload.error === "string"
        ? `Google OAuth token exchange failed: ${payload.error}`
        : "Google OAuth token exchange failed",
    );
  }

  return {
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : undefined,
  };
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<string> {
  const [clientId, clientSecret] = await Promise.all([
    googleClientId(),
    googleClientSecret(),
  ]);

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    },
  );

  const payload = (await response.json()) as Record<
    string,
    unknown
  >;

  if (
    !response.ok ||
    typeof payload.access_token !== "string"
  ) {
    throw new Error(
      typeof payload.error === "string"
        ? `Google refresh failed: ${payload.error}`
        : "Google refresh failed",
    );
  }

  return payload.access_token;
}

async function gmailProfile(
  accessToken: string,
): Promise<{ emailAddress: string }> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error("Unable to read Gmail profile");
  }

  const payload = (await response.json()) as {
    emailAddress?: unknown;
  };

  if (typeof payload.emailAddress !== "string") {
    throw new Error(
      "Gmail profile did not return an email address",
    );
  }

  return {
    emailAddress: payload.emailAddress
      .trim()
      .toLowerCase(),
  };
}

async function readStatus(
  request: Request,
  companyId: number,
): Promise<GmailSourceStatus> {
  const [
    encryptedToken,
    connectedEmail,
    lastSyncAt,
    lastSyncCount,
    lastSyncStatus,
    clientId,
    clientSecret,
    aiKey,
    organizationRules,
  ] = await Promise.all([
    getConfig(companyId, "REFRESH_TOKEN"),
    getConfig(companyId, "EMAIL"),
    getConfig(companyId, "LAST_SYNC_AT"),
    getConfig(companyId, "LAST_SYNC_COUNT"),
    getConfig(companyId, "LAST_SYNC_STATUS"),
    googleClientId(),
    googleClientSecret(),
    getRuntimeConfig("OPENAI_API_KEY"),
    listGmailOrganizationRules(companyId),
  ]);

  const activeOrganizerRules = organizationRules.filter(
    (rule) => rule.isActive && rule.status === "active",
  ).length;
  const organizerErrors = organizationRules.filter(
    (rule) => rule.isActive && rule.status === "error",
  ).length;

  return {
    oauthConfigured: Boolean(
      clientId && clientSecret,
    ),
    aiConfigured: Boolean(aiKey),
    expectedEmail: sourceEmail(),
    connected: Boolean(
      encryptedToken && connectedEmail,
    ),
    connectedEmail: connectedEmail || null,
    lastSyncAt: lastSyncAt || null,
    lastSyncCount:
      Number(lastSyncCount ?? 0) || 0,
    lastSyncStatus: lastSyncStatus || null,
    // Background Gmail invoice scanning is removed: only explicit Sync Now triggers reads.
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 0,
    redirectUri: getRedirectUri(request),
    scope: OAUTH_SCOPE,
    organizerRuleCount: organizationRules.filter(
      (rule) => rule.isActive,
    ).length,
    organizerActiveCount: activeOrganizerRules,
    organizerErrorCount: organizerErrors,
  };
}

// Gmail invoice scanning and labeling are manual-only.
// No startup timer, interval or background OAuth scan is registered here.

router.get(
  "/recon-classification/invoice-sources/gmail/status",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.query.company_id,
      );
      if (!companyId) return;

      res.json(await readStatus(req, companyId));
    } catch (error) {
      req.log.error(
        { error },
        "Failed to read Gmail invoice source status",
      );
      res.status(503).json({
        error:
          "Status sumber invoice Gmail belum tersedia.",
      });
    }
  },
);

// Provisional Match INV discovery: read-only evidence, never a payable or an
// approvable bank-reconciliation match. Actual approval requires a posted VI.
router.get(
  "/recon-classification/invoice-sources/gmail/match-proposals",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
      const companyId = requireCompanyScope(res, actor, req.query.company_id);
      if (!companyId) return;
      const mutationId = parsePositiveInt(req.query.mutation_id);
      if (!mutationId) {
        res.status(400).json({ error: "mutation_id wajib diisi" });
        return;
      }
      const mutation = await pool.query<{ amount: string; description: string | null }>(
        `select amount, description from public.bank_mutations
          where id=$1 and company_id=$2 and direction='OUT' and amount <> 0 limit 1`,
        [mutationId, companyId],
      );
      if (!mutation.rows[0]) {
        res.status(404).json({ error: "Mutasi pembayaran vendor tidak ditemukan." });
        return;
      }
      const amount = Math.abs(Number(mutation.rows[0].amount));
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "Nominal mutasi tidak valid." });
        return;
      }
      const result = await pool.query<{
        id: number; extracted_vendor_name: string | null;
        extracted_invoice_number: string | null; extracted_total: string;
        attachment_file_name: string; source_email: string; extracted_json: unknown;
      }>(
        `select s.id, s.extracted_vendor_name, s.extracted_invoice_number,
                s.extracted_total, s.attachment_file_name, s.source_email, s.extracted_json
           from public.gmail_invoice_candidates s
          where s.company_id=$1
            and s.status='ready' and s.extraction_status='complete'
            and s.vendor_invoice_id is null
            and coalesce(s.extracted_total,0) > 0
            and nullif(trim(s.extracted_vendor_name),'') is not null
            and nullif(trim(s.extracted_invoice_number),'') is not null
            and s.attachment_file_name !~* '^srt([[:space:]_.-]|$)'
            and s.attachment_file_name !~* '(^|[/_])FK[_-]'
            and exists (
              select 1
                from regexp_match(s.attachment_file_name,
                  'Per[. _-]*Posting(JUL|AUG|SEP|OCT|NOV|DEC)26|Per[. _-]*Posting(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(2[7-9]|[3-9][0-9])',
                  'i') as detected
            )
            and not exists (
              select 1 from public.vendor_invoices vi
               where vi.company_id=s.company_id
                 and lower(coalesce(vi.vendor_invoice_ref,''))=lower(coalesce(s.extracted_invoice_number,''))
                 and coalesce(s.extracted_invoice_number,'') <> ''
            )
          order by s.received_at desc nulls last, s.id desc limit 200`,
        [companyId],
      );
      res.json({
        mutationId,
        provisional: true,
        approvable: false,
        requires: "Finance Review, verified primary Vendor Invoice, posting and normal Match INV controls",
        candidates: result.rows.flatMap((row) => {
          const data = row.extracted_json && typeof row.extracted_json === "object"
            ? row.extracted_json as Record<string, unknown> : {};
          const lines = Array.isArray(data.line_items) ? data.line_items : [];
          const breakdown: Array<{ label: string; dpp: number; rate: number; pph: number }> = [];
          // Only explicit PPh labels may provide a proposed withholding amount.
          // The generic OCR "tax" field is VAT and must NOT be treated as PPh.
          for (const value of lines) {
            if (!value || typeof value !== "object") continue;
            const line = value as Record<string, unknown>;
            const label = String(line.description ?? "");
            const rate = /konsesi.*pph.*23.*15\s*%/i.test(label) ? 0.15
              : /pemakaian\s+(?:listrik|air).*pph.*4.*2.*10\s*%/i.test(label) ? 0.10 : null;
            const total = Number(line.total);
            const vat = Number(line.tax);
            if (rate === null || !Number.isFinite(total) || !Number.isFinite(vat)
              || total <= vat || vat < 0) continue;
            const dpp = total - vat;
            breakdown.push({ label, dpp, rate, pph: Math.round(dpp * rate * 100) / 100 });
          }
          const pphAmount = breakdown.length && breakdown.length === lines.length
            ? Math.round(breakdown.reduce((sum, item) => sum + item.pph, 0) * 100) / 100
            : null;
          const grossAmount = Number(row.extracted_total);
          const estimatedNetAmount = pphAmount == null ? null
            : Math.round((grossAmount - pphAmount) * 100) / 100;
          const matchesGross = Math.abs(grossAmount - amount) < 0.01;
          const matchesNet = estimatedNetAmount !== null && Math.abs(estimatedNetAmount - amount) < 0.01;
          if (!matchesGross && !matchesNet) return [];
          return [{
            sourceCandidateId: row.id,
            source: "gmail_invoice_candidates",
            vendorName: row.extracted_vendor_name,
            reference: row.extracted_invoice_number,
            grossAmount,
            pphAmount,
            pphBreakdown: breakdown,
            pphStatus: pphAmount == null ? "needs_finance_review" : "estimated_from_invoice_labels",
            estimatedNetAmount,
            matchBasis: matchesNet ? "net_after_pph" : "gross",
            attachmentFileName: row.attachment_file_name,
            sourceEmail: row.source_email,
            reason: pphAmount === null
              ? "Nominal bruto cocok; PPh perlu Finance Review."
              : "PPh dihitung dari label tarif invoice; jenis objek pajak dan seluruh nilai menunggu Finance Review.",
          }];
        }).slice(0, 25),
      });
    } catch (error) {
      req.log.error({ error }, "Failed to discover Gmail source invoice proposals");
      res.status(503).json({ error: "Kandidat sementara Sumber INV belum dapat dimuat." });
    }
  },
);


router.get(
  "/recon-classification/invoice-sources/gmail/candidates",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.query.company_id,
      );
      if (!companyId) return;

      const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        100,
      );

      const requestedStatus = String(req.query.status ?? "ready");
      const allowedStatuses = ["ready", "review", "duplicate", "supporting", "imported", "rejected", "all"] as const;
      if (!allowedStatuses.some((value) => value === requestedStatus)) {
        res.status(400).json({ error: "Filter status invoice tidak valid." });
        return;
      }

      res.json({
        data: await listGmailInvoiceCandidates(
          companyId,
          limit,
          requestedStatus as (typeof allowedStatuses)[number],
        ),
      });
    } catch (error) {
      req.log.error(
        { error },
        "Failed to list Gmail invoice candidates",
      );
      res.status(503).json({
        error:
          "Kandidat invoice Gmail belum dapat dimuat.",
      });
    }
  },
);

router.get(
  "/recon-classification/invoice-sources/gmail/organization-rules",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.query.company_id,
      );
      if (!companyId) return;

      res.json({
        data: await listGmailOrganizationRules(companyId),
      });
    } catch (error) {
      req.log.error(
        { error },
        "Failed to list Gmail organization rules",
      );
      res.status(503).json({
        error: "Rule pengelompokan Gmail belum dapat dimuat.",
      });
    }
  },
);

router.post(
  "/recon-classification/invoice-sources/gmail/organization-rules/apply",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.body?.company_id,
      );
      if (!companyId) return;

      const encryptedToken = await getConfig(
        companyId,
        "REFRESH_TOKEN",
      );
      if (!encryptedToken) {
        res.status(409).json({
          error: "Gmail belum terhubung.",
          code: "GMAIL_NOT_CONNECTED",
        });
        return;
      }

      const accessToken = await refreshAccessToken(
        await decryptRefreshToken(encryptedToken),
      );
      const profile = await gmailProfile(accessToken);
      if (profile.emailAddress !== sourceEmail()) {
        res.status(409).json({
          error: `Akun Gmail terhubung bukan ${sourceEmail()}.`,
          code: "GMAIL_ACCOUNT_MISMATCH",
        });
        return;
      }

      const result = await provisionGmailOrganizationRules({
        companyId,
        accessToken,
        actorEmail: actor.email,
        // Bound a single user-triggered pass to avoid Gmail per-user rate spikes.
        senderScanLimit: 50,
      });

      res.status(result.failed > 0 ? 207 : 200).json({
        ok: result.failed === 0,
        ...result,
      });
    } catch (error) {
      req.log.error(
        { error },
        "Failed to provision Gmail organization rules",
      );
      res.status(503).json({
        error:
          error instanceof Error
            ? `Auto-label Gmail gagal: ${error.message}`
            : "Auto-label Gmail belum dapat diterapkan.",
        code: "GMAIL_ORGANIZER_FAILED",
      });
    }
  },
);

router.post(
  "/recon-classification/invoice-sources/gmail/connect",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.body?.company_id,
      );
      if (!companyId) return;

      const [clientId, clientSecret] =
        await Promise.all([
          googleClientId(),
          googleClientSecret(),
        ]);

      if (!clientId || !clientSecret) {
        res.status(503).json({
          error:
            "Google OAuth belum dikonfigurasi di server BizPortal.",
          code: "GOOGLE_OAUTH_NOT_CONFIGURED",
          redirectUri: getRedirectUri(req),
        });
        return;
      }

      const redirectUri = getRedirectUri(req);
      const returnPath = safeReturnPath(
        req.body?.return_path,
      );

      const state = await signState({
        companyId,
        actorEmail: actor.email
          .trim()
          .toLowerCase(),
        returnPath,
        issuedAt: Date.now(),
        nonce: crypto
          .randomBytes(16)
          .toString("base64url"),
      });

      const authorizeUrl = new URL(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );

      authorizeUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPE,
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent select_account",
        login_hint: sourceEmail(),
        state,
      }).toString();

      res.json({
        url: authorizeUrl.toString(),
        redirectUri,
      });
    } catch (error) {
      req.log.error(
        { error },
        "Failed to start Gmail invoice OAuth",
      );
      res.status(503).json({
        error:
          "Koneksi Gmail belum dapat dimulai.",
      });
    }
  },
);

router.get(
  "/recon-classification/invoice-sources/gmail/callback",
  async (req, res) => {
    let parsedState: SignedState | null = null;

    try {
      parsedState = await parseState(
        req.query.state,
      );
    } catch (error) {
      req.log.error(
        { error },
        "Gmail OAuth state validation failed",
      );
    }

    const fallbackPath =
      "/finance/recon-config?tab=invoice-sources";

    if (!parsedState) {
      redirectWithResult(res, fallbackPath, {
        gmail: "error",
        reason: "invalid_state",
      });
      return;
    }

    try {
      const actor = await requireFinanceAdmin(req);

      if (!actor) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "session_expired",
          },
        );
        return;
      }

      if (
        actor.email.trim().toLowerCase() !==
        parsedState.actorEmail
      ) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "actor_mismatch",
          },
        );
        return;
      }

      if (
        actor.companyId != null &&
        actor.companyId !== parsedState.companyId
      ) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "company_scope_mismatch",
          },
        );
        return;
      }

      if (typeof req.query.error === "string") {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: req.query.error,
          },
        );
        return;
      }

      const code =
        typeof req.query.code === "string"
          ? req.query.code
          : "";

      if (!code) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "missing_code",
          },
        );
        return;
      }

      const tokens =
        await exchangeAuthorizationCode(
          code,
          getRedirectUri(req),
        );

      const profile = await gmailProfile(
        tokens.access_token,
      );

      if (
        profile.emailAddress !== sourceEmail()
      ) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "wrong_account",
          },
        );
        return;
      }

      const priorEncrypted = await getConfig(
        parsedState.companyId,
        "REFRESH_TOKEN",
      );

      if (
        !tokens.refresh_token &&
        !priorEncrypted
      ) {
        redirectWithResult(
          res,
          parsedState.returnPath,
          {
            gmail: "error",
            reason: "refresh_token_missing",
          },
        );
        return;
      }

      if (tokens.refresh_token) {
        await setConfig(
          parsedState.companyId,
          "REFRESH_TOKEN",
          await encryptRefreshToken(
            tokens.refresh_token,
          ),
          {
            secret: true,
            description:
              "Encrypted OAuth refresh token for Gmail invoice source",
            actor: actor.email,
          },
        );
      }

      await setConfig(
        parsedState.companyId,
        "EMAIL",
        profile.emailAddress,
        {
          description:
            "Connected Gmail invoice source address",
          actor: actor.email,
        },
      );

      await setConfig(
        parsedState.companyId,
        "LAST_SYNC_STATUS",
        "connected",
        {
          description:
            "Last Gmail invoice source synchronization status",
          actor: actor.email,
        },
      );

      // OAuth success must not depend on Gmail label provisioning or quota.
      // Users can apply labels explicitly using the separate manual action.
      redirectWithResult(
        res,
        parsedState.returnPath,
        { gmail: "connected" },
      );
    } catch (error) {
      req.log.error(
        {
          error,
          companyId: parsedState.companyId,
        },
        "Gmail invoice OAuth callback failed",
      );

      redirectWithResult(
        res,
        parsedState.returnPath,
        {
          gmail: "error",
          reason: "oauth_failed",
        },
      );
    }
  },
);

router.post(
  "/recon-classification/invoice-sources/gmail/sync",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.body?.company_id,
      );
      if (!companyId) return;

      const encryptedToken = await getConfig(
        companyId,
        "REFRESH_TOKEN",
      );

      if (!encryptedToken) {
        res.status(409).json({
          error: "Gmail belum terhubung.",
          code: "GMAIL_NOT_CONNECTED",
        });
        return;
      }

      const accessToken = await refreshAccessToken(
        await decryptRefreshToken(encryptedToken),
      );

      const profile =
        await gmailProfile(accessToken);

      if (
        profile.emailAddress !== sourceEmail()
      ) {
        res.status(409).json({
          error: `Akun Gmail terhubung bukan ${sourceEmail()}.`,
          code: "GMAIL_ACCOUNT_MISMATCH",
        });
        return;
      }

      const result =
        await syncGmailInvoiceCandidates({
          companyId,
          accessToken,
          sourceEmail: profile.emailAddress,
          actorEmail: actor.email,
        });

      // No label backfill during Sync Now: label operations have a separate
      // explicit action and independent Gmail quota/rate limit.
      const now = new Date().toISOString();

      await Promise.all([
        setConfig(
          companyId,
          "LAST_SYNC_AT",
          now,
          {
            description:
              "Last successful Gmail invoice source sync time",
            actor: actor.email,
          },
        ),
        setConfig(
          companyId,
          "LAST_SYNC_COUNT",
          String(result.attachmentsSeen),
          {
            description:
              "Invoice attachments processed in latest Gmail sync",
            actor: actor.email,
          },
        ),
        setConfig(
          companyId,
          "LAST_SYNC_STATUS",
          result.failed > 0
            ? "partial"
            : "ok",
          {
            description:
              "Last Gmail invoice source synchronization status",
            actor: actor.email,
          },
        ),
      ]);

      res.json({
        ok: true,
        email: profile.emailAddress,
        ...result,
        syncedAt: now,
      });
    } catch (error) {
      req.log.error(
        { error },
        "Gmail invoice source sync failed",
      );

      res.status(503).json({
        error:
          error instanceof Error
            ? `Gmail sync gagal: ${error.message}`
            : "Gmail terhubung tetapi pembacaan email belum berhasil.",
        code: "GMAIL_SYNC_FAILED",
      });
    }
  },
);

// Rejecting an email source candidate never deletes mail, an AP invoice or a
// journal. Restoration explicitly reopens the candidate for manual review.
router.post(
  "/recon-classification/invoice-sources/gmail/candidates/:id/review",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
      const companyId = requireCompanyScope(res, actor, req.body?.company_id);
      if (!companyId) return;
      const candidateId = parsePositiveInt(req.params.id);
      if (!candidateId) {
        res.status(400).json({ error: "candidate id tidak valid." }); return;
      }
      const decision = req.body?.decision;
      if (decision !== "reject" && decision !== "restore") {
        res.status(400).json({ error: "Keputusan harus reject atau restore." }); return;
      }
      const result = await reviewGmailInvoiceCandidate({
        companyId, candidateId, actorEmail: actor.email,
        decision, reason: typeof req.body?.reason === "string" ? req.body.reason : "",
      });
      res.json({ ok: true, candidate: result });
    } catch (error) {
      const code = error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status) : 503;
      req.log.error({ error, candidateId: req.params.id }, "Failed to review Gmail candidate");
      res.status([400, 409].includes(code) ? code : 503).json({
        error: error instanceof Error ? error.message : "Keputusan kandidat tidak dapat disimpan.",
        code: error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "GMAIL_REVIEW_FAILED")
          : "GMAIL_REVIEW_FAILED",
      });
    }
  },
);

router.post(
  "/recon-classification/invoice-sources/gmail/candidates/:id/import",
  async (req, res) => {
    const actor = await requireFinanceAdmin(req);

    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const companyId = requireCompanyScope(
      res,
      actor,
      req.body?.company_id,
    );
    if (!companyId) return;

    const candidateId = parsePositiveInt(
      req.params.id,
    );
    if (!candidateId) {
      res.status(400).json({
        error: "candidate id wajib",
      });
      return;
    }

    try {
      const result =
        await importGmailInvoiceCandidate({
          companyId,
          candidateId,
          actorEmail: actor.email,
        });

      res.status(
        result.existing ? 200 : 201,
      ).json({
        ok: true,
        ...result,
        message: result.existing
          ? "Invoice tersebut sudah tersedia."
          : "Draft Vendor Invoice dibuat. Lakukan Finance Review dan Posting agar invoice menjadi kandidat Match INV.",
      });
    } catch (error) {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        Number.isInteger(
          Number(
            (error as { status?: unknown })
              .status,
          ),
        )
          ? Number(
              (error as { status?: unknown })
                .status,
            )
          : 500;

      req.log.error(
        {
          error,
          companyId,
          candidateId,
        },
        "Failed to import Gmail invoice candidate",
      );

      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : "Gagal membuat draft Vendor Invoice dari kandidat Gmail.",
      });
    }
  },
);

router.post(
  "/recon-classification/invoice-sources/gmail/disconnect",
  async (req, res) => {
    try {
      const actor = await requireFinanceAdmin(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const companyId = requireCompanyScope(
        res,
        actor,
        req.body?.company_id,
      );
      if (!companyId) return;

      await Promise.all([
        setConfig(
          companyId,
          "REFRESH_TOKEN",
          null,
          {
            secret: true,
            description:
              "Encrypted OAuth refresh token for Gmail invoice source",
            actor: actor.email,
          },
        ),
        setConfig(
          companyId,
          "EMAIL",
          null,
          {
            description:
              "Connected Gmail invoice source address",
            actor: actor.email,
          },
        ),
        setConfig(
          companyId,
          "LAST_SYNC_STATUS",
          "disconnected",
          {
            description:
              "Last Gmail invoice source synchronization status",
            actor: actor.email,
          },
        ),
      ]);

      res.json({ ok: true });
    } catch (error) {
      req.log.error(
        { error },
        "Failed to disconnect Gmail invoice source",
      );
      res.status(503).json({
        error:
          "Gmail belum dapat diputuskan.",
      });
    }
  },
);

export default router;
