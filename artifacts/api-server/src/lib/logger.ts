import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
// Pretty logging launches a worker whose build-time absolute path may not exist
// after Hostinger publishes the bundle. Keep stdout JSON by default.
const usePrettyTransport = !isProduction && process.env.PINO_PRETTY_ENABLED === "true";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(!usePrettyTransport
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
