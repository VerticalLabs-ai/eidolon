/**
 * Finite product-link grammar for Mission deep links (VAL-CROSS-076,
 * VAL-CROSS-083, VAL-CROSS-101).
 *
 * The closed grammar is:
 *
 *   /companies/:companyId/projects/:projectId/work
 *     ?thread=:threadId
 *     &mission=:runId
 *     [&<target>]
 *
 * where `<target>` is exactly one of:
 *
 *   question=<uuid>                              — current question set
 *   planRevision=<uuid>                          — plan revision
 *   approval=<uuid>                              — plan approval
 *   childThread=<uuid>                           — child subthread
 *   sourceRevision=<uuid>                        — source revision
 *   artifactVersion=<uuid>&artifact=<uuid>       — artifact version (requires artifact)
 *   citation=<uuid>&artifact=<uuid>&version=<uuid> — citation (requires artifact + version)
 *
 * Invariants enforced by this module:
 *
 *   - companyId, projectId, threadId, runId, and every target id are UUIDs.
 *   - At most one target kind is present.
 *   - `artifactVersion` requires `artifact`.
 *   - `citation` requires `artifact` and `version`.
 *
 * The API `Location` header remains under `/api/.../mission-runs/:runId` and
 * is NOT produced here; this module only owns the browser `links.ui` URL.
 *
 * Thread selection derives only from the target run's authoritative thread
 * ID (VAL-CROSS-083): the `thread` query parameter is a hint for initial
 * thread selection before the snapshot loads; once the authoritative run
 * snapshot is available, its `projectThreadId` wins over any URL hint.
 */

// ── Grammar constants ────────────────────────────────────────────────────

/** Stable query-parameter names for the closed Mission link grammar. */
export const MISSION_LINK_PARAM = {
  thread: 'thread',
  mission: 'mission',
  question: 'question',
  planRevision: 'planRevision',
  approval: 'approval',
  childThread: 'childThread',
  sourceRevision: 'sourceRevision',
  artifactVersion: 'artifactVersion',
  artifact: 'artifact',
  citation: 'citation',
  version: 'version',
} as const;

/** Path prefix for the canonical plural company/project route. The UI
 * redirect maps this to the singular app route and adds `tab=work`. */
export const MISSION_LINK_PATH_PREFIX = '/companies';

/** Subpath appended to the company/project path. The redirect strips this
 * and replaces it with `?tab=work` on the singular app route. */
export const MISSION_LINK_WORK_SUBPATH = 'work';

// ── Types ────────────────────────────────────────────────────────────────

/** Discriminated union for the optional link target. `run` is the absence
 * of a more specific target and is the default when no target params are
 * present. */
export type MissionLinkTarget =
  | { kind: 'run' }
  | { kind: 'question'; questionSetId: string }
  | { kind: 'planRevision'; revisionId: string }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'childThread'; childThreadId: string }
  | { kind: 'sourceRevision'; sourceRevisionId: string }
  | { kind: 'artifactVersion'; artifactId: string; version: string }
  | {
      kind: 'citation';
      citationId: string;
      artifactId: string;
      version: string;
    };

/** Kind discriminator (excludes the default `run`). */
export type MissionLinkTargetKind = MissionLinkTarget['kind'];

/** Full structured input for the canonical `links.ui` builder. */
export interface MissionLinkInput {
  companyId: string;
  projectId: string;
  threadId: string;
  runId: string;
  /** Optional target. Defaults to `{ kind: 'run' }` when omitted. */
  target?: MissionLinkTarget;
}

/** Subset of `MissionLinkInput` available from URL query params after the
 * app redirect maps `/companies/:c/p/:p/work` to `/company/:c/p/:p?tab=work`.
 * The route params supply `companyId`/`projectId`; the query supplies the
 * rest. Used by the UI parser. */
export interface MissionLinkParams {
  threadId: string;
  runId: string;
  target: MissionLinkTarget;
}

// ── UUID validation ──────────────────────────────────────────────────────

/** UUID v1-v5 regex (case-insensitive). The Mission schema uses UUIDs for
 * every scope and target id; this validates the URL-encoded form without
 * depending on a specific UUID library. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a canonical UUID string. */
export function isMissionLinkUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function requireUuid(value: string, name: string): void {
  if (!isMissionLinkUuid(value)) {
    throw new Error(`Invalid ${name}: expected UUID, got ${JSON.stringify(value)}`);
  }
}

// ── Builder ──────────────────────────────────────────────────────────────

/**
 * Build the canonical `links.ui` URL for a Mission run and optional target.
 * Throws on invalid UUIDs or invalid target combinations so the server
 * cannot emit a malformed deep link.
 *
 * The returned URL is a path-only string starting with `/companies/...` so
 * it is origin-agnostic and survives any loopback UI host. The API
 * `Location` header is separately produced by the route and always
 * remains under `/api/.../mission-runs/:runId`.
 */
export function buildMissionUiLink(input: MissionLinkInput): string {
  requireUuid(input.companyId, 'companyId');
  requireUuid(input.projectId, 'projectId');
  requireUuid(input.threadId, 'threadId');
  requireUuid(input.runId, 'runId');

  const params = new URLSearchParams();
  params.set(MISSION_LINK_PARAM.thread, input.threadId);
  params.set(MISSION_LINK_PARAM.mission, input.runId);
  if (input.target) {
    addTargetParams(params, input.target);
  }
  const qs = params.toString();
  return `${MISSION_LINK_PATH_PREFIX}/${input.companyId}/projects/${input.projectId}/${MISSION_LINK_WORK_SUBPATH}${qs ? `?${qs}` : ''}`;
}

function addTargetParams(params: URLSearchParams, target: MissionLinkTarget): void {
  switch (target.kind) {
    case 'run':
      // No additional params.
      return;
    case 'question':
      requireUuid(target.questionSetId, 'questionSetId');
      params.set(MISSION_LINK_PARAM.question, target.questionSetId);
      return;
    case 'planRevision':
      requireUuid(target.revisionId, 'revisionId');
      params.set(MISSION_LINK_PARAM.planRevision, target.revisionId);
      return;
    case 'approval':
      requireUuid(target.approvalId, 'approvalId');
      params.set(MISSION_LINK_PARAM.approval, target.approvalId);
      return;
    case 'childThread':
      requireUuid(target.childThreadId, 'childThreadId');
      params.set(MISSION_LINK_PARAM.childThread, target.childThreadId);
      return;
    case 'sourceRevision':
      requireUuid(target.sourceRevisionId, 'sourceRevisionId');
      params.set(MISSION_LINK_PARAM.sourceRevision, target.sourceRevisionId);
      return;
    case 'artifactVersion':
      requireUuid(target.artifactId, 'artifactId');
      requireUuid(target.version, 'version');
      params.set(MISSION_LINK_PARAM.artifactVersion, target.version);
      params.set(MISSION_LINK_PARAM.artifact, target.artifactId);
      return;
    case 'citation':
      requireUuid(target.citationId, 'citationId');
      requireUuid(target.artifactId, 'artifactId');
      requireUuid(target.version, 'version');
      params.set(MISSION_LINK_PARAM.citation, target.citationId);
      params.set(MISSION_LINK_PARAM.artifact, target.artifactId);
      params.set(MISSION_LINK_PARAM.version, target.version);
      return;
  }
}

// ── Parser ───────────────────────────────────────────────────────────────

/** Match the canonical path `/companies/:companyId/projects/:projectId/work`
 * with URL-encoded UUID segments. UUIDs are validated after decode. */
const PATH_RE = /^\/companies\/([^/]+)\/projects\/([^/]+)\/work$/;

/**
 * Parse a canonical `links.ui` URL or path into structured form. Returns
 * `null` for any URL that does not match the closed grammar, has non-UUID
 * ids, or carries an invalid target combination.
 *
 * Accepts both absolute URLs (e.g. `http://127.0.0.1:5174/companies/...`)
 * and path-only strings (e.g. `/companies/.../work?thread=...`).
 */
export function parseMissionUiLink(urlOrPath: string): MissionLinkInput | null {
  let url: URL;
  try {
    // Try parsing as an absolute URL first. If the input is path-only,
    // URL will throw because there is no base; fall back to a synthetic
    // origin so URL parsing preserves the path and query.
    url = new URL(urlOrPath);
  } catch {
    try {
      url = new URL(`https://mission.link.invalid${urlOrPath}`);
    } catch {
      return null;
    }
  }
  return parseMissionUiLinkUrl(url);
}

function parseMissionUiLinkUrl(url: URL): MissionLinkInput | null {
  const match = PATH_RE.exec(url.pathname);
  if (!match) {
    return null;
  }
  const companyId = decodeURIComponent(match[1]);
  const projectId = decodeURIComponent(match[2]);
  if (!isMissionLinkUuid(companyId) || !isMissionLinkUuid(projectId)) {
    return null;
  }

  const params = url.searchParams;
  const threadId = params.get(MISSION_LINK_PARAM.thread);
  const runId = params.get(MISSION_LINK_PARAM.mission);
  if (!threadId || !runId) {
    return null;
  }
  if (!isMissionLinkUuid(threadId) || !isMissionLinkUuid(runId)) {
    return null;
  }

  const target = parseTarget(params);
  if (target === false) {
    return null;
  }
  return {
    companyId,
    projectId,
    threadId,
    runId,
    target: target ?? { kind: 'run' },
  };
}

/**
 * Extract the link target (thread/run/target) from URLSearchParams after the
 * app redirect maps `/companies/:c/p/:p/work` to `/company/:c/p/:p?tab=work`.
 * The route params supply `companyId`/`projectId`; this helper reads only the
 * query params that survive the redirect.
 *
 * Returns `null` when required params are missing or the target combination
 * is invalid. Returns the default `{ kind: 'run' }` target when no target
 * params are present.
 *
 * Unlike `parseMissionUiLink`, this helper does NOT validate UUID shape: the
 * server has already validated the canonical link when building it, and the
 * UI only needs to extract the params for highlighting/focus. It still
 * enforces the target-combination rules (at most one target kind,
 * `artifactVersion` requires `artifact`, `citation` requires `artifact` and
 * `version`) so a malformed or hostile link cannot confuse the UI.
 */
export function extractMissionLinkParams(params: URLSearchParams): MissionLinkParams | null {
  const threadId = params.get(MISSION_LINK_PARAM.thread);
  const runId = params.get(MISSION_LINK_PARAM.mission);
  if (!threadId || !runId) {
    return null;
  }
  const target = parseTargetLenient(params);
  if (target === false) {
    return null;
  }
  return {
    threadId,
    runId,
    target: target ?? { kind: 'run' },
  };
}

/**
 * Lenient target parser for UI use: validates target combinations (at most
 * one kind, `artifactVersion` requires `artifact`, `citation` requires
 * `artifact` and `version`) without enforcing UUID shape, since the server
 * has already validated the canonical link. Returns `null` for no target,
 * `false` for an invalid combination, or a `MissionLinkTarget` for a valid
 * target.
 */
function parseTargetLenient(params: URLSearchParams): MissionLinkTarget | false | null {
  const question = params.get(MISSION_LINK_PARAM.question);
  const planRevision = params.get(MISSION_LINK_PARAM.planRevision);
  const approval = params.get(MISSION_LINK_PARAM.approval);
  const childThread = params.get(MISSION_LINK_PARAM.childThread);
  const sourceRevision = params.get(MISSION_LINK_PARAM.sourceRevision);
  const artifactVersion = params.get(MISSION_LINK_PARAM.artifactVersion);
  const citation = params.get(MISSION_LINK_PARAM.citation);
  const artifact = params.get(MISSION_LINK_PARAM.artifact);
  const version = params.get(MISSION_LINK_PARAM.version);

  const presentKinds = [
    question,
    planRevision,
    approval,
    childThread,
    sourceRevision,
    artifactVersion,
    citation,
  ].filter((v) => v !== null);
  if (presentKinds.length > 1) {
    return false;
  }

  if (question !== null) {
    return { kind: 'question', questionSetId: question };
  }
  if (planRevision !== null) {
    return { kind: 'planRevision', revisionId: planRevision };
  }
  if (approval !== null) {
    return { kind: 'approval', approvalId: approval };
  }
  if (childThread !== null) {
    return { kind: 'childThread', childThreadId: childThread };
  }
  if (sourceRevision !== null) {
    return { kind: 'sourceRevision', sourceRevisionId: sourceRevision };
  }
  if (artifactVersion !== null) {
    if (!artifact) {
      return false;
    }
    return { kind: 'artifactVersion', artifactId: artifact, version: artifactVersion };
  }
  if (citation !== null) {
    if (!artifact || !version) {
      return false;
    }
    return { kind: 'citation', citationId: citation, artifactId: artifact, version };
  }
  return null;
}

/**
 * Build a simple single-UUID target (question/planRevision/approval/
 * childThread/sourceRevision) from its kind and validated id.
 */
function simpleTarget(kind: MissionLinkTargetKind, id: string): MissionLinkTarget {
  switch (kind) {
    case 'question':
      return { kind, questionSetId: id };
    case 'planRevision':
      return { kind, revisionId: id };
    case 'approval':
      return { kind, approvalId: id };
    case 'childThread':
      return { kind, childThreadId: id };
    case 'sourceRevision':
      return { kind, sourceRevisionId: id };
    default:
      // The caller only passes simple single-UUID kinds; the compound
      // kinds (artifactVersion/citation) and `run` are handled elsewhere.
      throw new Error(`simpleTarget does not handle kind ${kind as string}`);
  }
}

/**
 * Parse the optional target from query params. Returns:
 *   - `null` when no target params are present (the default `run` target).
 *   - `false` when the target combination is invalid (rejected).
 *   - A `MissionLinkTarget` (never `kind: 'run'`) for a valid target.
 */
function parseTarget(params: URLSearchParams): MissionLinkTarget | false | null {
  const question = params.get(MISSION_LINK_PARAM.question);
  const planRevision = params.get(MISSION_LINK_PARAM.planRevision);
  const approval = params.get(MISSION_LINK_PARAM.approval);
  const childThread = params.get(MISSION_LINK_PARAM.childThread);
  const sourceRevision = params.get(MISSION_LINK_PARAM.sourceRevision);
  const artifactVersion = params.get(MISSION_LINK_PARAM.artifactVersion);
  const citation = params.get(MISSION_LINK_PARAM.citation);
  const artifact = params.get(MISSION_LINK_PARAM.artifact);
  const version = params.get(MISSION_LINK_PARAM.version);

  // At most one target kind may be present. Count the kind-specific params
  // that were supplied; `artifact`/`version` belong to artifactVersion or
  // citation and are not counted here.
  const presentKinds = [
    question,
    planRevision,
    approval,
    childThread,
    sourceRevision,
    artifactVersion,
    citation,
  ].filter((v) => v !== null);
  if (presentKinds.length > 1) {
    return false;
  }

  // Simple single-UUID target kinds share one validation path so the
  // branching complexity stays bounded.
  const simpleKinds: ReadonlyArray<{ kind: MissionLinkTargetKind; value: string | null }> = [
    { kind: 'question', value: question },
    { kind: 'planRevision', value: planRevision },
    { kind: 'approval', value: approval },
    { kind: 'childThread', value: childThread },
    { kind: 'sourceRevision', value: sourceRevision },
  ];
  for (const { kind, value } of simpleKinds) {
    if (value === null) {
      continue;
    }
    if (!isMissionLinkUuid(value)) {
      return false;
    }
    return simpleTarget(kind, value);
  }
  if (artifactVersion !== null) {
    if (!artifact || !isMissionLinkUuid(artifact) || !isMissionLinkUuid(artifactVersion)) {
      return false;
    }
    return { kind: 'artifactVersion', artifactId: artifact, version: artifactVersion };
  }
  if (citation !== null) {
    if (
      !artifact ||
      !version ||
      !isMissionLinkUuid(citation) ||
      !isMissionLinkUuid(artifact) ||
      !isMissionLinkUuid(version)
    ) {
      return false;
    }
    return { kind: 'citation', citationId: citation, artifactId: artifact, version };
  }
  return null;
}
