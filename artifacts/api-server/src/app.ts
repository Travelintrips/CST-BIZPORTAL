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

{
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(distDir, "public");
  const indexFile = path.join(publicDir, "index.html");

  if (process.env.NODE_ENV === "production" && !existsSync(indexFile)) {
    throw new Error(
      `Production frontend bundle is missing: ${indexFile}. Run the root build before starting the app.`,
    );
  }

  if (existsSync(indexFile)) {
  // Built Vite assets have content-hashed names: cache them across repeat visits.
  // HTML, API responses, and non-fingerprinted files retain their current policy.
  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

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
}

export default app;
