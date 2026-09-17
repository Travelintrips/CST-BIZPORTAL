import { Router, type IRouter, type Response } from "express";
import https from "node:https";
import healthRouter from "./health";
import companiesRouter from "./companies";
import bankReconciliationRouter from "./bank-reconciliation";
import accountingRouter from "./accounting";
import purchaseWorkflowRouter from "./purchase-workflow";
import { createDevAuthRouter, getDevSession, type DevAuthUser } from "./dev-auth";
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

router.use(createDevAuthRouter({
  onLogin: establishDevelopmentUpstreamSession,
  onProductionLogin: establishProductionUpstreamSession,
}));
router.use(companiesRouter);
router.use(bankReconciliationRouter);
router.use(accountingRouter);
router.use(purchaseWorkflowRouter);

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
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(res);
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
