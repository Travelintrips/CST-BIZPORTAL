import app from "./app";
import { logger } from "./lib/logger";
import { runFleetAutoReminderSweep } from "./lib/fleet-wa-reminder";
import { runQrisAutoCandidateSweep } from "./routes/bank-reconciliation";
import {
  initializeProductionSessionSigning,
  isDevelopmentEnvironment,
} from "./routes/dev-auth";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = process.env["HOST"]?.trim() || "0.0.0.0";

if (!isDevelopmentEnvironment()) {
  await initializeProductionSessionSigning();
  logger.info("Production session signing initialized");
}

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
});

let fleetReminderRunning = false;
const runFleetReminderTick = async () => {
  if (fleetReminderRunning) return;
  fleetReminderRunning = true;
  try {
    const results = await runFleetAutoReminderSweep();
    if (results.length) logger.info({ results }, "Fleet auto WA reminder sweep completed");
  } catch (error) {
    logger.error({ error }, "Fleet auto WA reminder sweep failed");
  } finally {
    fleetReminderRunning = false;
  }
};

const fleetReminderTimer = setInterval(() => {
  void runFleetReminderTick();
}, 5 * 60 * 1000);
fleetReminderTimer.unref();
setTimeout(() => void runFleetReminderTick(), 20_000).unref();

let qrisAutoCandidateRunning = false;
const runQrisAutoCandidateTick = async () => {
  if (qrisAutoCandidateRunning) return;
  qrisAutoCandidateRunning = true;
  try {
    const result = await runQrisAutoCandidateSweep();
    if (
      result.recoveredExistingSettlement > 0
      || result.preparedFromLivePayments > 0
      || result.ambiguousExistingSettlements > 0
      || result.failed > 0
    ) {
      logger.info({ result }, "QRIS Sport Center auto-candidate sweep completed");
    }
  } catch (error) {
    logger.error({ error }, "QRIS Sport Center auto-candidate sweep failed");
  } finally {
    qrisAutoCandidateRunning = false;
  }
};

const qrisAutoCandidateIntervalMs = Math.max(
  30_000,
  Number(process.env["QRIS_AUTO_CANDIDATE_INTERVAL_MS"] ?? 60_000) || 60_000,
);
const qrisAutoCandidateTimer = setInterval(() => {
  void runQrisAutoCandidateTick();
}, qrisAutoCandidateIntervalMs);
qrisAutoCandidateTimer.unref();
setTimeout(() => void runQrisAutoCandidateTick(), 30_000).unref();

server.on("error", (err) => {
  logger.error({ err, port, host }, "Error listening on host/port");
  process.exit(1);
});


const stopBackgroundTimers = () => {
  clearInterval(fleetReminderTimer);
  clearInterval(qrisAutoCandidateTimer);
};
process.once("SIGTERM", stopBackgroundTimers);
process.once("SIGINT", stopBackgroundTimers);
