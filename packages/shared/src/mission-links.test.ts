import { describe, expect, it } from 'vitest';
import {
  buildMissionUiLink,
  parseMissionUiLink,
  extractMissionLinkParams,
  isMissionLinkUuid,
  MISSION_LINK_PARAM,
  type MissionLinkTarget,
} from './mission-links.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const COMPANY = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const THREAD = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-000000000004';
const QUESTION = '00000000-0000-4000-8000-000000000010';
const PLAN_REV = '00000000-0000-4000-8000-000000000011';
const APPROVAL = '00000000-0000-4000-8000-000000000012';
const CHILD_THREAD = '00000000-0000-4000-8000-000000000013';
const SOURCE_REV = '00000000-0000-4000-8000-000000000014';
const ARTIFACT = '00000000-0000-4000-8000-000000000015';
const ARTIFACT_VER = '00000000-0000-4000-8000-000000000016';
const CITATION = '00000000-0000-4000-8000-000000000017';

function baseInput(target?: MissionLinkTarget) {
  return { companyId: COMPANY, projectId: PROJECT, threadId: THREAD, runId: RUN, target };
}

// ── UUID validation ──────────────────────────────────────────────────────

describe('isMissionLinkUuid', () => {
  it('accepts a canonical UUID', () => {
    expect(isMissionLinkUuid(RUN)).toBe(true);
  });

  it('accepts an uppercase UUID', () => {
    expect(isMissionLinkUuid(RUN.toUpperCase())).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(isMissionLinkUuid('run-1')).toBe(false);
    expect(isMissionLinkUuid('')).toBe(false);
    expect(isMissionLinkUuid('not-a-uuid')).toBe(false);
  });

  it('rejects a UUID with wrong variant bits', () => {
    expect(isMissionLinkUuid('00000000-0000-4000-0000-000000000004')).toBe(false);
  });
});

// ── Builder ──────────────────────────────────────────────────────────────

describe('buildMissionUiLink', () => {
  it('builds the canonical run link with /work and thread+mission query', () => {
    const url = buildMissionUiLink(baseInput());
    expect(url).toBe(
      `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}`,
    );
  });

  it('places /work after the project segment, not before the query', () => {
    const url = buildMissionUiLink(baseInput());
    expect(url).toMatch(/\/work\?/);
  });

  it('throws on a non-UUID company id', () => {
    expect(() => buildMissionUiLink({ ...baseInput(), companyId: 'not-a-uuid' })).toThrow();
  });

  it('throws on a non-UUID thread id', () => {
    expect(() => buildMissionUiLink({ ...baseInput(), threadId: 'thread-1' })).toThrow();
  });

  it('appends the question target', () => {
    const url = buildMissionUiLink(baseInput({ kind: 'question', questionSetId: QUESTION }));
    expect(url).toContain(`question=${QUESTION}`);
    expect(url).toContain(`thread=${THREAD}`);
    expect(url).toContain(`mission=${RUN}`);
  });

  it('appends the planRevision target', () => {
    const url = buildMissionUiLink(baseInput({ kind: 'planRevision', revisionId: PLAN_REV }));
    expect(url).toContain(`planRevision=${PLAN_REV}`);
  });

  it('appends the approval target', () => {
    const url = buildMissionUiLink(baseInput({ kind: 'approval', approvalId: APPROVAL }));
    expect(url).toContain(`approval=${APPROVAL}`);
  });

  it('appends the childThread target', () => {
    const url = buildMissionUiLink(baseInput({ kind: 'childThread', childThreadId: CHILD_THREAD }));
    expect(url).toContain(`childThread=${CHILD_THREAD}`);
  });

  it('appends the sourceRevision target', () => {
    const url = buildMissionUiLink(
      baseInput({ kind: 'sourceRevision', sourceRevisionId: SOURCE_REV }),
    );
    expect(url).toContain(`sourceRevision=${SOURCE_REV}`);
  });

  it('appends artifactVersion with the required artifact id', () => {
    const url = buildMissionUiLink(
      baseInput({ kind: 'artifactVersion', artifactId: ARTIFACT, version: ARTIFACT_VER }),
    );
    expect(url).toContain(`artifactVersion=${ARTIFACT_VER}`);
    expect(url).toContain(`artifact=${ARTIFACT}`);
    // No citation param
    expect(url).not.toContain('citation=');
  });

  it('appends citation with required artifact and version', () => {
    const url = buildMissionUiLink(
      baseInput({
        kind: 'citation',
        citationId: CITATION,
        artifactId: ARTIFACT,
        version: ARTIFACT_VER,
      }),
    );
    expect(url).toContain(`citation=${CITATION}`);
    expect(url).toContain(`artifact=${ARTIFACT}`);
    expect(url).toContain(`version=${ARTIFACT_VER}`);
  });

  it('throws when artifactVersion is missing the artifact id', () => {
    expect(() =>
      buildMissionUiLink(
        baseInput({ kind: 'artifactVersion', artifactId: '', version: ARTIFACT_VER }),
      ),
    ).toThrow();
  });

  it('throws when citation is missing the version id', () => {
    expect(() =>
      buildMissionUiLink(
        baseInput({ kind: 'citation', citationId: CITATION, artifactId: ARTIFACT, version: '' }),
      ),
    ).toThrow();
  });
});

// ── Parser: path-only and absolute URLs ─────────────────────────────────

describe('parseMissionUiLink', () => {
  it('round-trips a path-only run link', () => {
    const url = buildMissionUiLink(baseInput());
    const parsed = parseMissionUiLink(url);
    expect(parsed).toEqual(baseInput({ kind: 'run' }));
  });

  it('round-trips an absolute http URL', () => {
    const path = buildMissionUiLink(baseInput());
    const parsed = parseMissionUiLink(`http://127.0.0.1:5174${path}`);
    expect(parsed).toEqual(baseInput({ kind: 'run' }));
  });

  it('round-trips every target variant', () => {
    const targets: MissionLinkTarget[] = [
      { kind: 'run' },
      { kind: 'question', questionSetId: QUESTION },
      { kind: 'planRevision', revisionId: PLAN_REV },
      { kind: 'approval', approvalId: APPROVAL },
      { kind: 'childThread', childThreadId: CHILD_THREAD },
      { kind: 'sourceRevision', sourceRevisionId: SOURCE_REV },
      { kind: 'artifactVersion', artifactId: ARTIFACT, version: ARTIFACT_VER },
      { kind: 'citation', citationId: CITATION, artifactId: ARTIFACT, version: ARTIFACT_VER },
    ];
    for (const target of targets) {
      const url = buildMissionUiLink(baseInput(target));
      const parsed = parseMissionUiLink(url);
      expect(parsed).toEqual(baseInput(target));
    }
  });

  it('returns null for a non-mission path', () => {
    expect(parseMissionUiLink('/companies/c/p/projects/p?thread=x&mission=y')).toBeNull();
  });

  it('returns null when /work subpath is missing', () => {
    expect(
      parseMissionUiLink(
        `/companies/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}`,
      ),
    ).toBeNull();
  });

  it('returns null when thread is missing', () => {
    expect(
      parseMissionUiLink(`/companies/${COMPANY}/projects/${PROJECT}/work?mission=${RUN}`),
    ).toBeNull();
  });

  it('returns null when mission is missing', () => {
    expect(
      parseMissionUiLink(`/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}`),
    ).toBeNull();
  });

  it('returns null when thread is not a UUID', () => {
    expect(
      parseMissionUiLink(
        `/companies/${COMPANY}/projects/${PROJECT}/work?thread=thread-1&mission=${RUN}`,
      ),
    ).toBeNull();
  });

  it('returns null when mission is not a UUID', () => {
    expect(
      parseMissionUiLink(
        `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=run-1`,
      ),
    ).toBeNull();
  });

  it('rejects two target kinds at once', () => {
    const url = `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}&question=${QUESTION}&planRevision=${PLAN_REV}`;
    expect(parseMissionUiLink(url)).toBeNull();
  });

  it('rejects artifactVersion without artifact', () => {
    const url = `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}&artifactVersion=${ARTIFACT_VER}`;
    expect(parseMissionUiLink(url)).toBeNull();
  });

  it('rejects citation without version', () => {
    const url = `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}&citation=${CITATION}&artifact=${ARTIFACT}`;
    expect(parseMissionUiLink(url)).toBeNull();
  });

  it('rejects citation without artifact', () => {
    const url = `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}&citation=${CITATION}&version=${ARTIFACT_VER}`;
    expect(parseMissionUiLink(url)).toBeNull();
  });

  it('rejects a non-UUID target id', () => {
    const url = `/companies/${COMPANY}/projects/${PROJECT}/work?thread=${THREAD}&mission=${RUN}&question=not-a-uuid`;
    expect(parseMissionUiLink(url)).toBeNull();
  });

  it('returns null for a completely malformed URL', () => {
    expect(parseMissionUiLink('not a url at all')).toBeNull();
  });
});

// ── extractMissionLinkParams (post-redirect client helper) ──────────────

describe('extractMissionLinkParams', () => {
  it('extracts params from a URLSearchParams that survived the redirect', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    params.set(MISSION_LINK_PARAM.mission, RUN);
    params.set('tab', 'work');
    const extracted = extractMissionLinkParams(params);
    expect(extracted).toEqual({ threadId: THREAD, runId: RUN, target: { kind: 'run' } });
  });

  it('extracts a question target', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    params.set(MISSION_LINK_PARAM.mission, RUN);
    params.set(MISSION_LINK_PARAM.question, QUESTION);
    const extracted = extractMissionLinkParams(params);
    expect(extracted?.target).toEqual({ kind: 'question', questionSetId: QUESTION });
  });

  it('returns null when mission is missing', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    expect(extractMissionLinkParams(params)).toBeNull();
  });

  it('returns null when the target combination is invalid', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    params.set(MISSION_LINK_PARAM.mission, RUN);
    params.set(MISSION_LINK_PARAM.question, QUESTION);
    params.set(MISSION_LINK_PARAM.planRevision, PLAN_REV);
    expect(extractMissionLinkParams(params)).toBeNull();
  });

  it('accepts non-UUID ids because the server already validated the canonical link', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, 'thread-1');
    params.set(MISSION_LINK_PARAM.mission, 'run-1');
    const extracted = extractMissionLinkParams(params);
    expect(extracted).toEqual({ threadId: 'thread-1', runId: 'run-1', target: { kind: 'run' } });
  });

  it('rejects artifactVersion without artifact even with lenient UUID validation', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    params.set(MISSION_LINK_PARAM.mission, RUN);
    params.set(MISSION_LINK_PARAM.artifactVersion, ARTIFACT_VER);
    expect(extractMissionLinkParams(params)).toBeNull();
  });

  it('rejects citation without artifact or version', () => {
    const params = new URLSearchParams();
    params.set(MISSION_LINK_PARAM.thread, THREAD);
    params.set(MISSION_LINK_PARAM.mission, RUN);
    params.set(MISSION_LINK_PARAM.citation, CITATION);
    expect(extractMissionLinkParams(params)).toBeNull();
  });
});
