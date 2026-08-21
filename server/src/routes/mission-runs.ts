import { Router, type Response } from 'express';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { missionErrorSanitizer } from '../middleware/mission-error-sanitizer.js';
import { isFeatureEnabled } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import { hasPermission, type Permission } from '../middleware/permissions.js';
import { MissionStartService } from '../services/mission/start.js';
import {
  MissionSnapshotService,
  isValidStatus,
  decodeCursor,
} from '../services/mission/snapshot.js';
import { MissionReplayService } from '../services/mission/replay.js';
import { MissionStreamService } from '../services/mission/stream.js';
import { MissionCommandService, type RunCommandType } from '../services/mission/commands.js';
import { MissionCommandHistoryService } from '../services/mission/command-history.js';
import { validateIdempotencyKey, normalizeCommandBody } from '../services/mission/idempotency.js';
import { redactCanaries } from '../services/mission/reason-security.js';
import {
  incrementMissionSseConnection,
  incrementMissionSseReplay,
} from '../middleware/observability.js';
import type { DbInstance } from '../types.js';

const MODES = ['fast', 'deep_work', 'analyst', 'auto'] as const;

const StartBody = z.object({
  projectThreadId: z.string().uuid(),
  mode: z.enum(MODES),
  initiatingAgentId: z.string().uuid().optional(),
  request: z.object({
    // No semantic trimming (VAL-RUN-134): the ingress module counts Unicode
    // code points without trimming, so whitespace is preserved. The Zod
    // schema only validates structural shape; exact bounds are enforced
    // by the ingress module after decoding.
    text: z.string().min(1),
    attachments: z.array(z.string().uuid()).max(20).optional(),
    context: z.record(z.unknown()).optional(),
  }),
  limits: z
    .object({
      costCents: z.number().int().positive().optional(),
      totalTokens: z.number().int().positive().optional(),
      durationSeconds: z.number().int().positive().optional(),
      providerCalls: z.number().int().positive().optional(),
      steps: z.number().int().positive().optional(),
      outputBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

const ListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const EventsQuery = z.object({
  /** Run-local sequence cursor; default 0 replays from creation. */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** SSE stream query: optional `after` cursor (explicit `after` wins over
 *  Last-Event-ID header; default 0 replays from creation). */
const StreamQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

/** Command history query: bounded page with opaque keyset cursor. */
const CommandsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/** Shared optional lower-limit override shape for retry. */
const RetryLimits = z
  .object({
    costCents: z.number().int().positive().optional(),
    totalTokens: z.number().int().positive().optional(),
    durationSeconds: z.number().int().positive().optional(),
    providerCalls: z.number().int().positive().optional(),
    steps: z.number().int().positive().optional(),
    outputBytes: z.number().int().positive().optional(),
  })
  .optional();

const RetryRequest = z
  .object({
    text: z.string().min(1).optional(),
    attachments: z.array(z.string().uuid()).max(20).optional(),
    context: z.record(z.unknown()).optional(),
  })
  .optional();

/**
 * Cancellation reason schema: required, NFC-normalized, 1–2,000 Unicode code
 * points (counted as spread code points, not UTF-16 code units). No semantic
 * trimming — whitespace is preserved (VAL-RUN-138).
 */
const ReasonSchema = z
  .string()
  .transform((s) => s.normalize('NFC'))
  .refine((s) => {
    const codepoints = [...s].length;
    return codepoints >= 1 && codepoints <= 2000;
  }, 'Cancellation reason must be 1–2000 Unicode code points');

/** Canonical discriminated command body. The canonical endpoint and each
 *  convenience route map to the same logical `{type, body}` so they share one
 *  idempotency namespace (VAL-RUN-115). */
const CommandBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.cancel'), reason: ReasonSchema }),
  z.object({ type: z.literal('run.retry'), limits: RetryLimits, request: RetryRequest }),
]);

const CancelBody = z.object({ reason: ReasonSchema });
const RetryBody = z.object({ limits: RetryLimits, request: RetryRequest });

/** Validate the Idempotency-Key header (shared contract: 1-128 safe chars,
 *  no controls, no leading/trailing whitespace). Missing or invalid →
 *  400 VALIDATION_ERROR before any command/state/event change (VAL-RUN-114). */
function requireIdempotencyKey(req: { get: (h: string) => string | undefined }): string {
  return validateIdempotencyKey(req.get('Idempotency-Key'));
}

/**
 * Parse a strong quoted `If-Match` ETag (`"<state_version>"`) into the
 * integer state version. Returns null when the header is absent. A
 * present-but-malformed header is rejected with 400 VALIDATION_ERROR so a
 * client cannot accidentally bypass the precondition with garbage.
 */
function parseIfMatch(req: { get: (h: string) => string | undefined }): number | null {
  const header = req.get('If-Match');
  if (!header) {
    return null;
  }
  const match = /^"(\d+)"$/.exec(header.trim());
  if (!match) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'If-Match must be a quoted state version, e.g. "3"',
    );
  }
  return Number(match[1]);
}

function requireMissionEnabled(companyId: string): void {
  if (!isFeatureEnabled('missionAgentIntelligence', companyId)) {
    throw new AppError(
      404,
      'FEATURE_NOT_AVAILABLE',
      'Mission runs are not available for this company',
    );
  }
}

/**
 * Parse a strong quoted ETag from an If-None-Match header. Returns the
 * unquoted state-version string, or null when the header is absent or does
 * not match the `"<version>"` strong-ETag shape used by Mission snapshots.
 */
function parseIfNoneMatch(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  // Accept a single strong quoted ETag. Weak prefixes (W/) are not used by
  // Mission snapshots and are not treated as a match.
  const match = /^"([^"]+)"$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Create a periodic access checker for an SSE stream connection. The
 * checker re-resolves the user's membership and permission on each call
 * so that a role downgrade or membership removal invalidates an open
 * connection within the poll interval (VAL-CROSS-088).
 *
 * In `local_trusted` mode the checker first consults
 * `local_trusted_sessions` (server-side mutable role/active flag), then
 * falls back to `company_members`. In authenticated mode it queries
 * `company_members` directly.
 *
 * Returns `true` when the user still holds the required `permission` for
 * `companyId`, `false` otherwise.
 */
export function createStreamAccessChecker(
  db: DbInstance,
  req: { get: (h: string) => string | undefined; user?: { id?: string } },
  companyId: string,
  permission: Permission,
): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const schema = db.schema;

    // 1. Check the session token first (highest priority — server-side
    //    mutable for live revocation). This works in any auth mode: if a
    //    session token is present, it's the authoritative role source.
    const sessionToken = req.get('X-Eidolon-Test-Session-Id');
    if (sessionToken) {
      try {
        const [session] = await db.drizzle
          .select()
          .from(schema.localTrustedSessions)
          .where(eq(schema.localTrustedSessions.id, sessionToken))
          .limit(1);
        if (!session || session.companyId !== companyId) {
          return false;
        }
        if (!session.active) {
          return false;
        }
        return hasPermission(session.role as 'owner' | 'admin' | 'member' | 'viewer', permission);
      } catch {
        return false;
      }
    }

    // 2. Resolve the user ID from the authenticated request.
    const userId = req.user?.id;
    if (!userId) {
      return false;
    }

    // 3. Query company_members for the current role.
    try {
      const [member] = await db.drizzle
        .select({ role: schema.companyMembers.role })
        .from(schema.companyMembers)
        .where(
          and(
            eq(schema.companyMembers.companyId, companyId),
            eq(schema.companyMembers.userId, userId),
          ),
        )
        .limit(1);

      if (!member) {
        return false;
      }
      return hasPermission(member.role as 'owner' | 'admin' | 'member' | 'viewer', permission);
    } catch {
      return false;
    }
  };
}

export function missionRunsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs
  // Scoped run list with stable opaque keyset pagination and status filter.
  router.get('/', async (req, res) => {
    const { companyId, projectId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error; // caught by errorHandler as ZodError → 400 VALIDATION_ERROR
    }
    const { status, limit, cursor } = parsed.data;
    if (status !== undefined && !isValidStatus(status)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Unknown status filter: ${status}`);
    }
    // Decode the cursor early so a malformed cursor is a 400, not a 500.
    decodeCursor(cursor);

    const service = new MissionSnapshotService(db);
    const result = await service.listRuns({ companyId, projectId, status, limit, cursor });

    res.json({ data: { runs: result.runs, nextCursor: result.nextCursor } });
  });

  // POST /api/companies/:companyId/projects/:projectId/mission-runs
  router.post('/', validate(StartBody), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const body = req.body as z.infer<typeof StartBody>;

    await validateProjectOwnership(db, companyId, projectId);
    requireMissionEnabled(companyId);
    const idempotencyKey = requireIdempotencyKey(req);

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey,
      body,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    const location = `/api/companies/${companyId}/projects/${projectId}/mission-runs/${result.run.id}`;
    const linksUi = `/companies/${companyId}/projects/${projectId}?thread=${body.projectThreadId}&run=${result.run.id}`;

    res
      .status(202)
      .location(location)
      .setHeader('ETag', `"${result.run.stateVersion}"`)
      .json({
        data: { run: result.run, command: result.command },
        links: { ui: linksUi },
      });
  });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs/:runId
  // Authoritative complete snapshot with strong ETag and conditional refresh.
  router.get('/:runId', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const service = new MissionSnapshotService(db);
    const snapshot = await service.getSnapshot(companyId, projectId, runId);

    const etag = `"${snapshot.stateVersion}"`;
    res.setHeader('ETag', etag);

    // Conditional refresh: a matching strong ETag returns 304 with no body.
    const ifNoneMatch = parseIfNoneMatch(req.get('If-None-Match'));
    if (ifNoneMatch !== null && ifNoneMatch === String(snapshot.stateVersion)) {
      res.status(304).end();
      return;
    }

    res.json({ data: { run: snapshot, links: snapshot.links } });
  });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs/:runId/events
  // Bounded JSON journal replay for tests/recovery. Returns ordered committed
  // events and a stable next cursor; rejects an impossible cursor with 409.
  router.get('/:runId/events', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const parsed = EventsQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error; // caught by errorHandler as ZodError → 400 VALIDATION_ERROR
    }
    const { after, limit } = parsed.data;

    const service = new MissionReplayService(db);
    const result = await service.replay({ companyId, projectId, runId, after, limit });

    res.json({
      data: {
        events: result.events,
        nextCursor: result.nextCursor,
        latestSequence: result.latestSequence,
      },
    });
  });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs/:runId/stream
  // Authenticated SSE: replays committed events by run-local sequence, then
  // tails the journal for live delivery. Explicit `after` query param wins
  // over `Last-Event-ID` header; default 0 replays from creation. Sends
  // comment heartbeats while idle, disconnects slow clients, and closes
  // gracefully after a terminal event. Reads do not require the mission flag.
  router.get('/:runId/stream', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const parsed = StreamQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error; // caught by errorHandler as ZodError → 400 VALIDATION_ERROR
    }
    const after = parsed.data.after ?? null;

    // Parse Last-Event-ID header (lenient: ignore non-integer values).
    const lastEventIdHeader = req.get('Last-Event-ID');
    let lastEventId: number | null = null;
    if (lastEventIdHeader) {
      const parsed = Number(lastEventIdHeader);
      if (Number.isInteger(parsed) && parsed >= 0) {
        lastEventId = parsed;
      }
    }

    const service = new MissionStreamService(db);
    const accessChecker = createStreamAccessChecker(db, req, companyId, 'company.view');
    // Increment SSE connection counter (VAL-RUN-078).
    incrementMissionSseConnection();
    // If the client is reconnecting from a non-zero cursor, count it as a replay.
    if (after !== null && after > 0) {
      incrementMissionSseReplay();
    } else if (lastEventId !== null && lastEventId > 0) {
      incrementMissionSseReplay();
    }
    await service.stream(
      { companyId, projectId, runId, after, lastEventId, accessChecker },
      req,
      res,
    );
  });

  // POST /:runId/commands — canonical discriminated command endpoint for
  // run-scoped mutations. Shares one (company, runId, idempotencyKey)
  // namespace with the convenience routes (VAL-RUN-115).
  router.post('/:runId/commands', validate(CommandBody), async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);
    const body = req.body as z.infer<typeof CommandBody>;

    await validateProjectOwnership(db, companyId, projectId);
    requireMissionEnabled(companyId);
    const idempotencyKey = requireIdempotencyKey(req);
    const ifMatch = parseIfMatch(req);

    const service = new MissionCommandService(db);
    const type = body.type as RunCommandType;
    // Normalize the logical body by stripping undefined values so that
    // canonical and convenience routes produce the same hash for omitted
    // optional fields (HIGH-RISK REPAIR: route equivalence).
    // For cancel, redact credential/header canaries from the reason before
    // hashing so the plaintext is safe for idempotency comparison (VAL-RUN-138).
    const logicalBody =
      body.type === 'run.cancel'
        ? normalizeCommandBody({ reason: redactCanaries(body.reason).redacted })
        : normalizeCommandBody({ limits: body.limits, request: body.request });
    const result = await service.submit({
      companyId,
      projectId,
      runId,
      type,
      body: logicalBody,
      idempotencyKey,
      ifMatch,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    sendCommandResponse(res, companyId, projectId, result);
  });

  // POST /:runId/cancel — convenience mapping to run.cancel.
  router.post('/:runId/cancel', validate(CancelBody), async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);
    const body = req.body as z.infer<typeof CancelBody>;

    await validateProjectOwnership(db, companyId, projectId);
    requireMissionEnabled(companyId);
    const idempotencyKey = requireIdempotencyKey(req);
    const ifMatch = parseIfMatch(req);

    const service = new MissionCommandService(db);
    const result = await service.submit({
      companyId,
      projectId,
      runId,
      type: 'run.cancel',
      body: normalizeCommandBody({ reason: redactCanaries(body.reason).redacted }),
      idempotencyKey,
      ifMatch,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    sendCommandResponse(res, companyId, projectId, result);
  });

  // POST /:runId/retry — convenience mapping to run.retry.
  router.post('/:runId/retry', validate(RetryBody), async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);
    const body = req.body as z.infer<typeof RetryBody>;

    await validateProjectOwnership(db, companyId, projectId);
    requireMissionEnabled(companyId);
    const idempotencyKey = requireIdempotencyKey(req);
    const ifMatch = parseIfMatch(req);

    const service = new MissionCommandService(db);
    const result = await service.submit({
      companyId,
      projectId,
      runId,
      type: 'run.retry',
      body: normalizeCommandBody(body),
      idempotencyKey,
      ifMatch,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    sendCommandResponse(res, companyId, projectId, result);
  });

  // GET /:runId/commands — scoped, bounded command history with opaque
  // keyset cursors, actor/result metadata, and redacted payload access by
  // permission. Domain-rejected commands remain visible; middleware 401/403
  // attempts create no user-readable command row. Reads do not require the
  // mission flag (VAL-RUN-075).
  router.get('/:runId/commands', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const parsed = CommandsQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }
    const { limit, cursor } = parsed.data;

    // Decode the cursor early so a malformed cursor is a 400, not a 500.
    decodeCursor(cursor);

    // Determine payload access by permission: viewers (company.view only)
    // receive redacted payloads; contributors (content.create) see payloads.
    const role = (req.organizationMembership?.role ?? 'viewer') as
      'owner' | 'admin' | 'member' | 'viewer';
    const includePayload = hasPermission(role, 'content.create');

    const service = new MissionCommandHistoryService(db);
    const result = await service.listCommands({
      companyId,
      projectId,
      runId,
      limit,
      cursor,
      includePayload,
    });

    // Enrich command history entries with traceId from the run_commands
    // table. This is done in the route handler rather than in listCommands
    // to avoid modifying the HIGH-risk listCommands method (VAL-RUN-076).
    const commandIds = result.commands.map((c) => c.id);
    const traceById = new Map<string, string | null>();
    if (commandIds.length > 0) {
      const traceRows = await db.drizzle
        .select({ id: db.schema.runCommands.id, traceId: db.schema.runCommands.traceId })
        .from(db.schema.runCommands)
        .where(inArray(db.schema.runCommands.id, commandIds));
      for (const row of traceRows) {
        traceById.set(row.id, row.traceId);
      }
    }
    const commands = result.commands.map((c) => ({
      ...c,
      traceId: traceById.get(c.id) ?? null,
    }));

    res.json({ data: { commands, nextCursor: result.nextCursor } });
  });

  // Mission error sanitizer: converts any error thrown by a Mission route
  // handler into a safe AppError before it reaches the global errorHandler.
  // This ensures raw credentials, prompts, provider bodies, retrieved
  // content, and raw diagnostics never appear in a Mission API error
  // response (VAL-RUN-046).
  router.use(missionErrorSanitizer);

  return router;
}

/** Emit a command response: status, ETag, optional Location (retry), body. */
function sendCommandResponse(
  res: Response,
  companyId: string,
  projectId: string,
  result: {
    statusCode: number;
    etag: number;
    run: { id: string };
    command: unknown;
    successorRunId?: string;
  },
): void {
  res.status(result.statusCode).setHeader('ETag', `"${result.etag}"`);
  if (result.successorRunId) {
    res.location(
      `/api/companies/${companyId}/projects/${projectId}/mission-runs/${result.successorRunId}`,
    );
  }
  res.json({ data: { run: result.run, command: result.command } });
}
