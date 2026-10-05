import app from "./app";
import { logger } from "./lib/logger";
import { runFleetAutoReminderSweep } from "./lib/fleet-wa-reminder";
import { initializeProductionSessionSigning, isDevelopmentEnvironment } from "./routes/dev-auth";

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer.");
const host = process.env.HOST?.trim() || "0.0.0.0";

if (!isDevelopmentEnvironment()) {
  await initializeProductionSessionSigning();
}

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Fleet API listening");
});

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const result = await runFleetAutoReminderSweep();
    if (result.length) logger.info({ result }, "Fleet WA reminder sweep completed");
  } catch (error) {
    logger.error({ error }, "Fleet WA reminder sweep failed");
  } finally {
    running = false;
  }
};

const timer = setInterval(() => void tick(), 5 * 60 * 1000);
timer.unref();
setTimeout(() => void tick(), 20_000).unref();

const stop = () => clearInterval(timer);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.on("error", (error) => {
  logger.error({ error }, "Fleet API server error");
  process.exit(1);
});
