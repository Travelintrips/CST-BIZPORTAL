import { Router, type IRouter } from "express";
import https from "node:https";
import healthRouter from "./health";
import {
  buildUpstreamHeaders,
  rewriteSetCookies,
  validateUpstreamOrigin,
} from "./proxy-policy";

const router: IRouter = Router();

router.use(healthRouter);

const upstreamOrigin = validateUpstreamOrigin(
  process.env.BIZPORTAL_API_ORIGIN ?? "https://cstlogistic.co.id",
);

router.use((req, res) => {
  const upstreamUrl = new URL(req.originalUrl, upstreamOrigin);
  const headers = buildUpstreamHeaders(req.headers, upstreamOrigin);

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
});

export default router;
