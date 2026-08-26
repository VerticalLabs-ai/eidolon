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
 * The browser never invents artifact, citation, or provenance state; every
 * field is server-authoritative. The partial-evidence warning is derived
 * from the authoritative run snapshot's `resultCompleteness` field.
 */

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
}: {
  companyId: string;
  projectId: string;
  runId: string;
  /** Whether the run completed with partial evidence (VAL-RES-043). */
  partialEvidence?: boolean;
  /** Artifact id from a citation deep-link target; restricts targetCitationId
   *  to the matching artifact revision so only that revision auto-focuses
   *  and auto-opens its provenance drawer (VAL-RES-037, VAL-CROSS-041). */
  targetArtifactId?: string;
  /** Citation id from a deep-link target to auto-focus and auto-open
   *  provenance (VAL-RES-037, VAL-CROSS-041). */
  targetCitationId?: string;
}) {
  const artifactsQuery = useMissionRunArtifacts(companyId, projectId, runId);
  const artifacts = (artifactsQuery.data?.artifacts ?? []) as MissionArtifactSummary[];

  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="mb-3" data-testid="mission-artifact-section">
      <p className="text-xs font-medium text-text-secondary mb-2">Artifacts</p>
      <div className="space-y-3">
        {artifacts.map((a) => (
          <ArtifactRevisionView
            key={a.artifactId}
            companyId={companyId}
            projectId={projectId}
            runId={runId}
            artifact={a}
            partialEvidence={partialEvidence}
            targetCitationId={
              targetArtifactId && a.artifactId === targetArtifactId ? targetCitationId : undefined
            }
          />
        ))}
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
  partialEvidence,
  targetCitationId,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  artifact: MissionArtifactSummary;
  partialEvidence?: boolean;
  /** Citation id to auto-focus and auto-open provenance for the deep-link
   *  target (only passed for the matching artifact revision). */
  targetCitationId?: string;
}) {
  const revisionQuery = useArtifactRevisionContent(
    companyId,
    artifact.artifactId,
    artifact.version,
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
          artifactVersion={artifact.version}
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
          <p className="text-xs text-error">Could not load artifact content for this revision.</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">No content available.</p>
      )}

      {/* Export controls pinned to the exact revision (VAL-RES-103) */}
      <MissionArtifactExport
        companyId={companyId}
        projectId={projectId}
        artifactId={artifact.artifactId}
        artifactVersion={artifact.version}
      />
    </div>
  );
}
