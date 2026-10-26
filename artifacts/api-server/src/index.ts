import app from "./app";
import { canRunLegacyKasScRuleBackfill } from "./lib/reconciliation/autoApprovalPolicy";
import { logger } from "./lib/logger";
import { runFleetAutoReminderSweep } from "./lib/fleet-wa-reminder";
import {
  runKasScApprovedRuleBackfill,
  runQrisAutoCandidateSweep,
} from "./routes/bank-reconciliation";
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

let startupInitializationTimer: NodeJS.Timeout | null = null;

async function initializeProductionSessionSigningInBackground(
  attempt = 1,
): Promise<void> {
  try {
    await initializeProductionSessionSigning();
    logger.info(
      { attempt },
      attempt === 1
        ? "Production session signing initialized"
        : "Production session signing recovered after retry",
    );
    startupInitializationTimer = null;
  } catch (error) {
    const exponent = Math.min(Math.max(attempt - 1, 0), 5);
    const backoffMs = Math.min(
      30_000,
      Math.max(1_000, 1_000 * (2 ** exponent)),
    );

    logger.warn(
      { error, attempt, backoffMs },
      "Production session signing initialization failed; server remains live and will retry",
    );

    startupInitializationTimer = setTimeout(() => {
      void initializeProductionSessionSigningInBackground(attempt + 1);
    }, backoffMs);
    startupInitializationTimer.unref();
  }
}

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
});

if (!isDevelopmentEnvironment()) {
  // Do not make process liveness depend on database/Secret Manager availability.
  // Authentication routes and /api/health/ready still fail closed until this
  // initialization succeeds, while static UI and /api/health/live remain up.
  void initializeProductionSessionSigningInBackground();
}

const embeddedFleetReminderEnabled =
  String(process.env["FLEET_EMBEDDED_REMINDER_ENABLED"] ?? "").trim().toLowerCase() === "true";

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

const fleetReminderTimer = embeddedFleetReminderEnabled
  ? setInterval(() => {
      void runFleetReminderTick();
    }, 5 * 60 * 1000)
  : null;

if (fleetReminderTimer) {
  fleetReminderTimer.unref();
  setTimeout(() => void runFleetReminderTick(), 20_000).unref();
  logger.warn(
    "Embedded Fleet reminder scheduler is enabled. Disable it after standalone Fleet cutover to avoid duplicate WhatsApp reminders.",
  );
} else {
  logger.info("Embedded Fleet reminder scheduler disabled; standalone Fleet owns reminder scheduling.");
}

let kasScRuleBackfillRunning = false;
const runKasScRuleBackfillTick = async () => {
  if (kasScRuleBackfillRunning) return;
  kasScRuleBackfillRunning = true;
  try {
    const result = await runKasScApprovedRuleBackfill();
    if (
      result.scanned > 0
      || result.autoPosted > 0
      || result.failed > 0
    ) {
      logger.info({ result }, "Kas Besar SC legacy Rule AI backfill completed");
    }
  } catch (error) {
    logger.error({ error }, "Kas Besar SC legacy Rule AI backfill failed");
  } finally {
    kasScRuleBackfillRunning = false;
  }
};

const kasScRuleBackfillTimer = canRunLegacyKasScRuleBackfill()
  ? setInterval(() => { void runKasScRuleBackfillTick(); }, 2 * 60 * 1000)
  : null;
if (kasScRuleBackfillTimer) {
  kasScRuleBackfillTimer.unref();
  setTimeout(() => void runKasScRuleBackfillTick(), 20_000).unref();
} else {
  logger.info("Legacy Kas Besar SC auto-approval backfill disabled by default.");
}

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
  if (fleetReminderTimer) clearInterval(fleetReminderTimer);
  clearInterval(qrisAutoCandidateTimer);
  if (kasScRuleBackfillTimer) clearInterval(kasScRuleBackfillTimer);
  if (startupInitializationTimer) {
    clearTimeout(startupInitializationTimer);
    startupInitializationTimer = null;
  }
};
process.once("SIGTERM", stopBackgroundTimers);
process.once("SIGINT", stopBackgroundTimers);
