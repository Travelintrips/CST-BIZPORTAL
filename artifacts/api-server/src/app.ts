import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.get("/gpt02-approval-bridge", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>GPT02 DEV Approval</title></head><body><script>location.replace("https://dev.cstlogistic.co.id/gpt02-approval-api/" + location.hash);</script><noscript>JavaScript diperlukan untuk menyelesaikan login GPT02 DEV.</noscript></body></html>`);
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(distDir, "public");
  const indexFile = path.join(publicDir, "index.html");

  if (!existsSync(indexFile)) {
    throw new Error(
      `Production frontend bundle is missing: ${indexFile}. Run the root build before starting the app.`,
    );
  }

  app.use(express.static(publicDir, { index: false }));

  app.use((req, res, next) => {
    if (
      req.method !== "GET" ||
      req.path === "/api" ||
      req.path.startsWith("/api/")
    ) {
      next();
      return;
    }

    res.sendFile(indexFile, (err) => {
      if (err) {
        next(err);
      }
    });
  });
}

export default app;
