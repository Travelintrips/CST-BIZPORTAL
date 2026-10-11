import express, { type Express, type NextFunction, type Request, type Response } from "express";
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

type JsonBodyParseError = SyntaxError & {
  status?: number;
  type?: string;
};

function isJsonBodyParseError(error: unknown): error is JsonBodyParseError {
  if (!(error instanceof SyntaxError)) return false;
  const candidate = error as JsonBodyParseError;
  return candidate.status === 400 && candidate.type === "entity.parse.failed";
}

app.use(
  (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!isJsonBodyParseError(error)) {
      next(error);
      return;
    }

    logger.warn(
      {
        method: req.method,
        path: req.path,
        contentType: req.get("content-type") ?? null,
        contentLength: req.get("content-length") ?? null,
      },
      "Rejected malformed JSON request body",
    );

    res.status(400).json({
      error: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  },
);

app.use("/api", router);

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
