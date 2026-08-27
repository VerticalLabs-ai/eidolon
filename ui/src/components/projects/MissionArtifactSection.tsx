import { useMissionRunArtifacts, useArtifactRevisionContent } from '@/lib/hooks';
import type { MissionArtifactSummary } from '@/lib/api';
import { MissionArtifactCitations } from './MissionArtifactCitations';
import { MissionArtifactExport } from './MissionArtifactExport';

/**
 * MissionArtifactSection — renders produced artifacts for a completed
 * Mission run with inline citations, provenance, stale notices, and
 * exact-revision export controls.
 *
 * (feature m5-f15-stale-evidence-export-ui; VAL-RES-035, VAL-RES-036,
 *  VAL-RES-042, VAL-RES-043, VAL-RES-088, VAL-RES-103)
 *
 * For each produced artifact, fetches the exact revision content and
 * renders:
 * - MissionArtifactCitations: inline citation marks, provenance drawer,
 *   stale/not-carried-forward notices, newer-source notice, source
 *   availability, partial-evidence warning, and citation/provenance error
 *   recovery with retry.
 * - MissionArtifactExport: accessible, recoverable exact-revision export
 *   controls (Markdown/HTML) pinned to the viewed revision.
 *
 * Deep-link version support (VAL-M1-055..071, VAL-M1-112): when a
 * `targetVersion` prop is present and matches the `targetArtifactId`,
 * the section loads that exact revision instead of the latest. Invalid
 * or non-existent versions and deleted artifacts show graceful errors.
 *
 * The browser never invents artifact, citation, or provenance state; every
 * field is server-authoritative. The partial-evidence warning is derived
 * from the authoritative run snapshot's `resultCompleteness` field.
 */

/** Parse a numeric version string from a deep link. Returns `null` for
 *  non-numeric or non-positive values (VAL-M1-065). */
function parseTargetVersion(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim()) {
    return null;
  }
  return n;
}

/**
 * Render the artifact section for a Mission run. Shows produced artifacts
 * with citations, provenance, stale notices, and export controls.
 */
export function MissionArtifactSection({
  companyId,
  projectId,
  runId,
  partialEvidence,
  targetArtifactId,
  targetCitationId,
  targetVersion,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  /** Whether the run completed with partial evidence (VAL-RES-043). */
  partialEvidence?: boolean;
  /** Artifact id from a citation/artifactVersion deep-link target; restricts
   *  targetCitationId to the matching artifact revision so only that revision
   *  auto-focuses and auto-opens its provenance drawer (VAL-RES-037,
   *  VAL-CROSS-041). */
  targetArtifactId?: string;
  /** Citation id from a deep-link target to auto-focus and auto-open
   *  provenance (VAL-RES-037, VAL-CROSS-041). */
  targetCitationId?: string;
  /** Numeric revision number from a deep-link `?version=N` parameter
   *  (VAL-M1-055, VAL-M1-062). When present and matching targetArtifactId,
   *  loads that exact revision instead of the latest. */
  targetVersion?: string;
}) {
  const artifactsQuery = useMissionRunArtifacts(companyId, projectId, runId);
  const artifacts = (artifactsQuery.data?.artifacts ?? []) as MissionArtifactSummary[];

  if (artifacts.length === 0) {
    // If a deep link targeted a specific artifact but none were produced
    // (e.g., the artifact was deleted), show a graceful error
    // (VAL-M1-112).
    if (targetArtifactId) {
      return (
        <div className="mb-3" data-testid="mission-artifact-section">
          <p className="text-xs font-medium text-text-secondary mb-2">Artifacts</p>
          <div
            role="alert"
            className="rounded-lg border border-error/20 bg-error/10 px-3 py-2"
            data-testid="artifact-not-found-error"
          >
            <p className="text-xs text-error">
              Artifact not found. It may have been deleted or is no longer available.
            </p>
          </div>
        </div>
      );
    }
    return null;
  }

  // Parse the deep-link version once (VAL-M1-065 — invalid format handled
  // gracefully, not as an API request).
  const parsedTargetVersion = parseTargetVersion(targetVersion);
  const hasInvalidVersion = targetVersion != null && parsedTargetVersion === null;

  return (
    <div className="mb-3" data-testid="mission-artifact-section">
      <p className="text-xs font-medium text-text-secondary mb-2">Artifacts</p>
      <div className="space-y-3">
        {/* Invalid version format notice (VAL-M1-065) — shown once above
            the artifact list so the user understands why the latest is
            loaded instead. */}
        {hasInvalidVersion && (
          <div
            role="alert"
            className="rounded-lg border border-warning/20 bg-warning/[0.06] px-3 py-2"
            data-testid="invalid-version-notice"
          >
            <p className="text-xs text-warning">
              Invalid version parameter “{targetVersion}”. Showing the latest revision.
            </p>
          </div>
        )}
        {artifacts.map((a) => {
          const isTargetArtifact = targetArtifactId && a.artifactId === targetArtifactId;
          // Use the deep-linked version when the artifact matches the target
          // and the version is valid; otherwise fall back to the latest
          // (VAL-M1-055, VAL-M1-056).
          const isTarget = !!isTargetArtifact;
          const effectiveVersion =
            isTarget && parsedTargetVersion !== null ? parsedTargetVersion : a.version;

          return (
            <ArtifactRevisionView
              key={a.artifactId}
              companyId={companyId}
              projectId={projectId}
              runId={runId}
              artifact={a}
              effectiveVersion={effectiveVersion}
              isDeepLinkedVersion={
                isTarget && parsedTargetVersion !== null && parsedTargetVersion !== a.version
              }
              partialEvidence={partialEvidence}
              targetCitationId={isTarget ? targetCitationId : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Render a single artifact revision with citations and export controls. */
function ArtifactRevisionView({
  companyId,
  projectId,
  runId,
  artifact,
  effectiveVersion,
  isDeepLinkedVersion,
  partialEvidence,
  targetCitationId,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  artifact: MissionArtifactSummary;
  /** The revision number to load — either the latest (artifact.version) or
   *  the deep-linked version (VAL-M1-055). */
  effectiveVersion: number;
  /** True when the effective version differs from the latest, i.e. the user
   *  is viewing an older revision via deep link (VAL-M1-058). */
  isDeepLinkedVersion: boolean;
  partialEvidence?: boolean;
  /** Citation id to auto-focus and auto-open provenance for the deep-link
   *  target (only passed for the matching artifact revision). */
  targetCitationId?: string;
}) {
  const revisionQuery = useArtifactRevisionContent(
    companyId,
    artifact.artifactId,
    effectiveVersion,
    projectId,
  );

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      {/* Artifact title */}
      <h5 className="text-sm font-medium text-text-primary mb-1 break-words">{artifact.title}</h5>

      {/* Citation rendering with stale notices, provenance, error recovery */}
      {revisionQuery.data?.content ? (
        <MissionArtifactCitations
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          artifactId={artifact.artifactId}
          artifactVersion={effectiveVersion}
          content={revisionQuery.data.content}
          targetCitationId={targetCitationId}
          partialEvidence={partialEvidence}
        />
      ) : revisionQuery.isLoading ? (
        <p className="text-xs text-text-muted" aria-live="polite">
          Loading artifact content…
        </p>
      ) : revisionQuery.isError ? (
        <div role="alert" className="mb-2 rounded-lg border border-error/20 bg-error/10 px-3 py-2">
          <p className="text-xs text-error" data-testid="artifact-revision-load-error">
            {isDeepLinkedVersion
              ? `Could not load revision ${effectiveVersion}. It may not exist for this artifact.`
              : 'Could not load artifact content for this revision.'}
          </p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">No content available.</p>
      )}

      {/* Export controls pinned to the exact revision (VAL-RES-103) */}
      <MissionArtifactExport
        companyId={companyId}
        projectId={projectId}
        artifactId={artifact.artifactId}
        artifactVersion={effectiveVersion}
      />
    </div>
  );
}
