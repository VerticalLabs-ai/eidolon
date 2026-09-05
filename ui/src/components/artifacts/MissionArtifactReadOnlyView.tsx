/**
 * MissionArtifactReadOnlyView — read-only formatted rendering of
 * Mission-produced research artifacts in the Artifacts tab.
 *
 * (fix-ut-m5-ui-artifact-rendering)
 *
 * When an artifact's content is a `research_report` (produced by Mission
 * synthesis), the Artifacts tab renders this read-only formatted view with
 * interactive inline citation marks, a provenance drawer, source links,
 * and a bidirectional "Back to Mission" link — instead of the plain
 * textarea DocEditor that showed non-interactive `[N]` markers.
 *
 * The component fetches the revision content and provenance (to obtain
 * the producing run ID for the "Back to Mission" link), then delegates
 * rendering to `MissionArtifactCitations`.
 */

import { useArtifactRevisionContent, useArtifactRevisionProvenance } from '@/lib/hooks';
import { MissionArtifactCitations } from '@/components/projects/MissionArtifactCitations';
import { MissionArtifactExport } from '@/components/projects/MissionArtifactExport';

/**
 * Detect whether artifact content is a Mission-produced research report.
 * Research reports have a `body` string (plain text with [N] markers) and
 * optionally a `citationMarks` array or `type: 'research_report'` field.
 */
export function isMissionResearchReport(content: Record<string, unknown> | undefined): boolean {
  if (!content) {
    return false;
  }
  return (
    content.type === 'research_report' ||
    (typeof content.body === 'string' && Array.isArray(content.citationMarks)) ||
    (typeof content.body === 'string' && content.body.length > 0 && 'citationMarks' in content)
  );
}

/**
 * Render a Mission-produced research artifact in read-only formatted mode
 * with interactive citations, provenance drawer, source links, export
 * controls, and a bidirectional "Back to Mission" link.
 */
export function MissionArtifactReadOnlyView({
  companyId,
  projectId,
  artifactId,
  artifactVersion,
  artifactTitle,
  targetCitationId,
}: {
  companyId: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  artifactTitle: string;
  /** Optional citation id to auto-focus and auto-open provenance for a
   *  deep-link target (VAL-RES-037, VAL-CROSS-041). */
  targetCitationId?: string;
}) {
  const revisionQuery = useArtifactRevisionContent(
    companyId,
    artifactId,
    artifactVersion,
    projectId,
  );
  const provenanceQuery = useArtifactRevisionProvenance(
    companyId,
    projectId,
    artifactId,
    artifactVersion,
  );

  // Get the runId from provenance for the "Back to Mission" link.
  const runId = provenanceQuery.data?.runId ?? '';

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <h5 className="text-sm font-medium text-text-primary mb-1 break-words">{artifactTitle}</h5>

      {revisionQuery.data?.content ? (
        <MissionArtifactCitations
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          artifactId={artifactId}
          artifactVersion={artifactVersion}
          content={revisionQuery.data.content}
          targetCitationId={targetCitationId}
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

      {/* Export controls pinned to the exact revision */}
      <MissionArtifactExport
        companyId={companyId}
        projectId={projectId}
        artifactId={artifactId}
        artifactVersion={artifactVersion}
      />
    </div>
  );
}
