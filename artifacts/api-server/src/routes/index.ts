import { Router, type IRouter, type Response } from "express";
import https from "node:https";
import healthRouter from "./health";
import companiesRouter from "./companies";
import bankReconciliationRouter from "./bank-reconciliation";
import accountingRouter from "./accounting";
import { createDevAuthRouter, getDevSession, type DevAuthUser } from "./dev-auth";
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  rewriteSetCookies,
} from "./proxy-policy";
import { getConfiguredUpstreamOrigin } from "../lib/gcp-secrets";

const router: IRouter = Router();

async function bridgeDevelopmentLogin(
  user: DevAuthUser,
  response: Response,
): Promise<void> {
  const upstreamOrigin = await getConfiguredUpstreamOrigin();
  const upstreamResponse = await fetch(
    new URL("/api/auth/dev-login", upstreamOrigin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    },
  );
  if (!upstreamResponse.ok) {
    throw new Error(`Development upstream login returned ${upstreamResponse.status}`);
  }

  const headers = upstreamResponse.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const upstreamCookies = headers.getSetCookie?.() ?? [];
  const rewrittenCookies = rewriteSetCookies(upstreamCookies);
  if (!rewrittenCookies || rewrittenCookies.length === 0) {
    throw new Error("Development upstream login did not return a session cookie");
  }

  const currentCookies = response.getHeader("set-cookie");
  const localCookies = Array.isArray(currentCookies)
    ? currentCookies.map(String)
    : currentCookies
      ? [String(currentCookies)]
      : [];
  response.setHeader("set-cookie", [...localCookies, ...rewrittenCookies]);
}

router.use(healthRouter);
router.use(createDevAuthRouter({ onLogin: bridgeDevelopmentLogin }));
router.use(companiesRouter);
router.use(bankReconciliationRouter);
router.use(accountingRouter);

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
