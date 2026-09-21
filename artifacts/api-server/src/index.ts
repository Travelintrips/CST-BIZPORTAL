import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"]?.trim() || "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = process.env["HOST"]?.trim() || "0.0.0.0";

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err, port, host }, "Error listening on host/port");
  process.exit(1);
});
