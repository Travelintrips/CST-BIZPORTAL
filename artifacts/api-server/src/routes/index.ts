import { Router, type IRouter, type Request, type Response } from "express";
import https from "node:https";
import healthRouter from "./health";
import companiesRouter from "./companies";
import bankReconciliationRouter from "./bank-reconciliation";
import accountingRouter from "./accounting";
import purchaseWorkflowRouter from "./purchase-workflow";
import {
  createDevAuthRouter,
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";
import { pool } from "@workspace/db";
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  rewriteSetCookies,
} from "./proxy-policy";
import { getConfiguredUpstreamOrigin } from "../lib/gcp-secrets";

const router: IRouter = Router();
const UPSTREAM_REQUEST_TIMEOUT_MS = 15_000;
const UPSTREAM_STREAM_TIMEOUT_MS = 120_000;

router.use(healthRouter);

function rewriteUpstreamAuthCookies(cookies: string[] | undefined): string[] {
  return (cookies ?? []).map((cookie) => {
    const withoutDomain = cookie.replace(/;\s*Domain=[^;]+/gi, "");
    return withoutDomain.replace(/^([^=]+)=/, `bizportal_upstream_$1=`);
  });
}

async function establishDevelopmentUpstreamSession(
  user: DevAuthUser,
  response: Response,
): Promise<void> {
  const upstreamOrigin = await getConfiguredUpstreamOrigin();
  if (upstreamOrigin.hostname === "cstlogistic.co.id") {
    throw new Error("Development login cannot use the production upstream");
  }

  const loginUrl = new URL("/api/auth/dev-login", upstreamOrigin);
  const body = JSON.stringify({ email: user.email });

  return new Promise((resolve, reject) => {
    const upstream = https.request(
      loginUrl,
      {
        method: "POST",
        headers: {
          host: loginUrl.host,
          origin: loginUrl.origin,
          referer: `${loginUrl.origin}/`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        const cookies = rewriteUpstreamAuthCookies(upstreamResponse.headers["set-cookie"]);
        upstreamResponse.resume();
        upstreamResponse.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            // The local development session is independently authenticated by
            // DEV_LOGIN_EMAILS and SESSION_SECRET. Keep local Accounting and
            // Finance routes usable when the optional upstream dev bridge is
            // unavailable; proxied requests still use the signed development
            // identity headers from buildUpstreamHeaders.
            if (statusCode === 404 || statusCode >= 500) {
              resolve();
              return;
            }
            reject(new Error(`Development upstream login failed (${statusCode})`));
            return;
          }
          for (const cookie of cookies) response.append("Set-Cookie", cookie);
          resolve();
        });
      },
    );

    upstream.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
      upstream.destroy(new Error("Development upstream login timed out"));
    });
    upstream.on("error", () => {
      // The upstream bridge is optional in development. The local signed
      // session remains sufficient for API-owned routes when the temporary
      // upstream is unavailable or its host has been retired.
      resolve();
    });
    upstream.end(body);
  });
}

async function establishProductionUpstreamSession(
  accessToken: string,
  _user: DevAuthUser,
  response: Response,
): Promise<void> {
  const upstreamOrigin = await getConfiguredUpstreamOrigin();
  const exchangeUrl = buildUpstreamUrl("/api/auth/supabase-exchange", upstreamOrigin);
  const body = JSON.stringify({ access_token: accessToken });

  return new Promise((resolve, reject) => {
    const upstream = https.request(
      exchangeUrl,
      {
        method: "POST",
        headers: {
          host: exchangeUrl.host,
          origin: exchangeUrl.origin,
          referer: `${exchangeUrl.origin}/`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        const cookies = rewriteSetCookies(upstreamResponse.headers["set-cookie"]) ?? [];
        upstreamResponse.resume();
        upstreamResponse.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Production upstream session exchange failed (${statusCode})`));
            return;
          }
          if (cookies.length === 0) {
            reject(new Error("Production upstream session exchange returned no cookie"));
            return;
          }
          for (const cookie of cookies) response.append("Set-Cookie", cookie);
          resolve();
        });
      },
    );

    upstream.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
      upstream.destroy(new Error("Production upstream session exchange timed out"));
    });
    upstream.on("error", reject);
    upstream.end(body);
  });
}

async function addTenantDashboardCompanyScope(req: Request, upstreamUrl: URL): Promise<void> {
  const requestUrl = new URL(req.originalUrl, "http://local-request");
  if (requestUrl.pathname !== "/api/tenant/dashboard") return;

  const hasCompanyScope = ["companyId", "company", "company_id"].some((key) => {
    const value = requestUrl.searchParams.get(key)?.trim() ?? "";
    return /^[1-9]\d*$/.test(value);
  });
  if (hasCompanyScope) return;

  const session = getProductionSession(req);
  if (!session) return;

  try {
    const user = await getProductionUser(session);
    if (user?.companyId && user.companyId > 0) {
      upstreamUrl.searchParams.set("companyId", String(user.companyId));
    }
  } catch (error) {
    // Preserve the upstream response when the local identity lookup is
    // temporarily unavailable; this compatibility step must not turn a
    // proxied request into a misleading success response.
    req.log.warn({ error }, "Unable to derive tenant dashboard company scope");
  }
}

router.use(createDevAuthRouter({
  onLogin: establishDevelopmentUpstreamSession,
  onProductionLogin: establishProductionUpstreamSession,
}));
router.use(companiesRouter);
router.use(bankReconciliationRouter);
router.use(accountingRouter);
router.use(purchaseWorkflowRouter);

router.post("/sport-center/payments/:id/void", async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const paymentId = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId ?? "") || !Number.isSafeInteger(paymentId)) {
    res.status(400).json({ error: "ID pembayaran tidak valid." });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 10) {
    res.status(400).json({ error: "Alasan void/reversal minimal 10 karakter." });
    return;
  }

  let actor: string | null = null;
  try {
    if (isDevelopmentEnvironment()) {
      actor = getDevSession(req)?.email ?? null;
    } else {
      const session = getProductionSession(req);
      if (session) {
        const user = await getProductionUser(session);
        actor = user?.email ?? null;
      }
    }
  } catch (error) {
    req.log.error({ error, paymentId }, "Sport Center payment authorization failed");
    res.status(503).json({ error: "Authorization service unavailable." });
    return;
  }

  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT sport_center.void_payment_for_recurring_replacement($1, $2, $3) AS audit",
      [paymentId, actor, reason],
    );
    res.json(result.rows[0]?.audit ?? null);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PAYMENT_NOT_FOUND")) {
      res.status(404).json({ error: "Pembayaran tidak ditemukan." });
      return;
    }
    if (message.includes("DUPLICATE_RECURRING_PAYMENT")) {
      res.status(409).json({
        error: "Recurring series ini sudah memiliki pembayaran aktif.",
        code: "DUPLICATE_RECURRING_PAYMENT",
      });
      return;
    }
    if (code === "23505") {
      res.status(409).json({ error: "Pembayaran recurring bentrok dengan transaksi aktif lain." });
      return;
    }
    req.log.error({ error, paymentId }, "Sport Center payment void failed");
    res.status(503).json({ error: "Void/reversal pembayaran belum tersedia." });
  }
});

router.use(async (req, res) => {
  let upstreamOrigin: URL;
  try {
    upstreamOrigin = await getConfiguredUpstreamOrigin();
  } catch (error) {
    req.log.error(
      {
        errorMessage: error instanceof Error ? error.message : "Unknown configuration error",
      },
      "BizPortal upstream configuration unavailable",
    );
    return res.status(503).json({
      error: "BizPortal API environment configuration is unavailable",
    });
  }

  const upstreamUrl = buildUpstreamUrl(req.originalUrl, upstreamOrigin);
  await addTenantDashboardCompanyScope(req, upstreamUrl);
  const headers = buildUpstreamHeaders(req.headers, upstreamOrigin, getDevSession(req));

  const upstream = https.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      const rewrittenCookies = rewriteSetCookies(responseHeaders["set-cookie"]);
      if (rewrittenCookies) {
        responseHeaders["set-cookie"] = rewrittenCookies;
      } else {
        delete responseHeaders["set-cookie"];
      }
      const requestPath = new URL(req.originalUrl, "http://local-request").pathname;
      const isRecurringPaymentCreate =
        req.method === "POST" && requestPath === "/api/sport-center/payments";
      if (!isRecurringPaymentCreate) {
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.on("end", () => {
        const body = Buffer.concat(chunks);
        const bodyText = body.toString("utf8");
        const hasRecurringConflictMarker =
          bodyText.includes("DUPLICATE_RECURRING_PAYMENT")
          || bodyText.includes("sport_payments_recurring_series_active_unique");
        if (hasRecurringConflictMarker && (upstreamResponse.statusCode ?? 502) >= 400) {
          res.status(409).json({
            error: "Recurring series ini sudah memiliki pembayaran aktif.",
            code: "DUPLICATE_RECURRING_PAYMENT",
          });
          return;
        }

        delete responseHeaders["transfer-encoding"];
        responseHeaders["content-length"] = String(body.byteLength);
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        res.end(body);
      });
    },
  );

  const isStream = req.originalUrl.endsWith("/alerts/stream")
    || req.originalUrl.endsWith("/drivers/events");
  upstream.setTimeout(
    isStream ? UPSTREAM_STREAM_TIMEOUT_MS : UPSTREAM_REQUEST_TIMEOUT_MS,
    () => {
      upstream.destroy(new Error("BizPortal upstream request timed out"));
    },
  );
  req.on("aborted", () => upstream.destroy(new Error("Client request aborted")));
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy(new Error("Client response closed"));
  });
  upstream.on("error", (error) => {
    req.log.error({ error, upstream: upstreamUrl.origin }, "BizPortal API proxy failed");
    if (!res.headersSent) {
      res.status(502).json({ error: "BizPortal API is unavailable" });
    } else {
      res.end();
    }
  });

  if (req.body !== undefined) {
    const contentType = req.headers["content-type"] ?? "";
    const body = contentType.includes("application/x-www-form-urlencoded")
      ? new URLSearchParams(req.body as Record<string, string>).toString()
      : JSON.stringify(req.body);
    upstream.setHeader("content-length", Buffer.byteLength(body));
    upstream.end(body);
    return;
  }

  req.pipe(upstream);
  return;
});

export default router;
