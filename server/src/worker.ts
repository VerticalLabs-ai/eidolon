import { randomUUID } from 'node:crypto';
import './env.js'; // must be first — loads .env from monorepo root
import './utils/tracing.js'; // OTel SDK init — must precede instrumented module loads

import { getDb } from './bootstrap.js';
import { RunCoordinator } from './services/mission/coordinator.js';
import { OrchestrationWorker } from './services/mission/worker.js';
import { RunProcessor } from './services/mission/run-processor.js';
import { PlannerService } from './services/mission/planner.js';
import { ProductionPlanGenerator } from './services/mission/planner-harness.js';
import { MissionKillSwitchService } from './services/mission/kill-switch.js';
import { MissionWorkerHealthService } from './services/mission/worker-health.js';
import { ProductionResearchExecutor } from './services/mission/research-executor.js';
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
// missionAgentIntelligence flag is disabled). The cancellation-deadline
// sweep (`enforceDeadlines()`, which terminalizes runs past their
// cancellation or root deadline) is wired into the same loop but throttled
// to a bounded 10–15s interval so its full-table scans do not run every
// poll.
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
// Bounded cancellation-deadline sweep interval. The deadline sweep
// terminalizes cancel-requested nonterminal runs and queued children whose
// `cancellationDeadlineAt` has passed (VAL-CROSS-058, VAL-RUN-109,
// VAL-SUB-096). It runs at most once per this interval (default 10s, within
// the 10–15s convergence bound), separate from the per-poll kill-switch
// sweep, because `enforceDeadlines` performs several full-table scans.
const DEADLINE_SWEEP_INTERVAL_MS =
  Number.parseInt(process.env.MISSION_WORKER_DEADLINE_SWEEP_MS ?? '', 10) || 10000;

async function main(): Promise<void> {
  const { db, client } = await getDb({ runMigrations: false, maxConnections: 5 });

  const coordinator = new RunCoordinator(db);
  // Wire the production planner into the run processor. Runs entering the
  // `planning` state with planningPolicy.strategy='always' invoke the planner
  // to generate a structured plan, publish it as a plan revision, and
  // transition to `awaiting_approval` (VAL-PLAN-007/008/009).
  //
  // The production generator calls the real Anthropic API. The test-only
  // `PlannerTestHarness` is gated by `MISSION_PLANNER_HARNESS` and is never
  // constructed here — the env gate stays closed in production.
  const planner = new PlannerService(db, { generator: new ProductionPlanGenerator() });
  // Wire the production research executor into the run processor. When a
  // child run with research steps is claimed and routed, the processor
  // delegates to this executor to invoke the ResearchExecutionService with
  // real Tavily/Firecrawl adapters, persist source revisions, and settle
  // budget before completing the run (fix-ut-m5-research-execution-wiring).
  const researchExecutor = new ProductionResearchExecutor(db);
  const processor = new RunProcessor(db, { planner, researchExecutor });
  const killSwitch = new MissionKillSwitchService(db);
  const workerHealth = new MissionWorkerHealthService(db);
  const workerId = `worker-${randomUUID().slice(0, 8)}`;

  // Wire the kill-switch sweep into the worker poll loop. This runs on
  // every poll cycle (before claiming) so disabled companies are cancelled
  // responsively without a separate cron process.
  const sweep = async (): Promise<void> => {
    await killSwitch.sweepAllDisabled();
  };

  // Bounded cancellation-deadline sweep: terminalize cancel-requested
  // nonterminal runs and queued children whose `cancellationDeadlineAt` has
  // passed, and abandon runs past their root deadline. Throttled to
  // DEADLINE_SWEEP_INTERVAL_MS by the worker so the expensive full-table
  // scans run at a bounded 10–15s interval rather than every poll
  // (VAL-CROSS-058, VAL-RUN-109, VAL-SUB-096).
  const deadlineSweep = async (): Promise<void> => {
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
    deadlineSweep,
    deadlineSweepIntervalMs: DEADLINE_SWEEP_INTERVAL_MS,
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
