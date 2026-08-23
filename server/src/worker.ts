import { randomUUID } from 'node:crypto';
import './env.js'; // must be first — loads .env from monorepo root
import './utils/tracing.js'; // OTel SDK init — must precede instrumented module loads

import { getDb } from './bootstrap.js';
import { RunCoordinator } from './services/mission/coordinator.js';
import { OrchestrationWorker } from './services/mission/worker.js';
import { RunProcessor } from './services/mission/run-processor.js';
import { MissionKillSwitchService } from './services/mission/kill-switch.js';
import { MissionWorkerHealthService } from './services/mission/worker-health.js';
import logger from './utils/logger.js';

// ---------------------------------------------------------------------------
// Orchestration worker entry point.
//
// This is a separate Node process with no HTTP port. It connects to the
// same Postgres as the API server, claims eligible Mission runs via
// durable leases, and advances them through the state machine.
//
// The kill-switch sweep is wired into the worker poll loop: every poll
// cycle calls `sweepAllDisabled()` (cancels runs in companies where the
// missionAgentIntelligence flag is disabled) and `enforceDeadlines()`
// (terminalizes runs past their cancellation or root deadline).
//
// Graceful shutdown:
//  - SIGTERM/SIGINT → OrchestrationWorker.stop() sets a shutdown flag,
//    aborts active calls, waits for a bounded commit window, and releases
//    the current lease so a replacement worker can recover the run.
//  - The Postgres client is closed after the worker stops.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = Number.parseInt(process.env.MISSION_WORKER_POLL_MS ?? '', 10) || 2000;
const RENEWAL_INTERVAL_MS =
  Number.parseInt(process.env.MISSION_WORKER_RENEWAL_MS ?? '', 10) || 10000;

async function main(): Promise<void> {
  const { db, client } = await getDb({ runMigrations: false, maxConnections: 5 });

  const coordinator = new RunCoordinator(db);
  const processor = new RunProcessor(db);
  const killSwitch = new MissionKillSwitchService(db);
  const workerHealth = new MissionWorkerHealthService(db);
  const workerId = `worker-${randomUUID().slice(0, 8)}`;

  // Wire the kill-switch sweep into the worker poll loop. This runs on
  // every poll cycle (before claiming) so disabled companies and abandoned
  // runs are handled without a separate cron process.
  const sweep = async (): Promise<void> => {
    await killSwitch.sweepAllDisabled();
    await killSwitch.enforceDeadlines();
  };

  // Record a worker heartbeat on every poll cycle so the snapshot service
  // can derive queueHealth from the most recent heartbeat age (VAL-RUN-088).
  const heartbeat = async (): Promise<void> => {
    await workerHealth.recordHeartbeat(workerId);
  };

  const worker = new OrchestrationWorker({
    coordinator,
    workerId,
    pollIntervalMs: POLL_INTERVAL_MS,
    renewalIntervalMs: RENEWAL_INTERVAL_MS,
    advance: (claim, signal) => processor.advance(claim, signal),
    sweep,
    heartbeat,
  });

  logger.info(
    {
      workerId: worker.workerId,
      pollIntervalMs: POLL_INTERVAL_MS,
      renewalIntervalMs: RENEWAL_INTERVAL_MS,
    },
    'Orchestration worker starting',
  );

  await worker.start();

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn('Forced worker shutdown (second signal)');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutdown signal received');

    try {
      await worker.stop();
    } catch (err) {
      logger.error({ err }, 'Error during worker stop');
    }

    try {
      await client.end({ timeout: 5 });
    } catch {
      // Client may already be closed.
    }

    logger.info('Orchestration worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Orchestration worker failed to start');
  process.exit(1);
});
