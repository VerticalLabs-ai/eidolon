import { FileText, Table, Link2 } from "lucide-react";
import { Link } from "react-router-dom";

const typeIcons: Record<string, typeof FileText> = {
  document: FileText,
  sheet: Table,
};

const typeLabels: Record<string, string> = {
  document: "Doc",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
  timeline: "Timeline",
};

/**
 * Inline artifact card rendered in thread items when the agent's response
 * references a produced artifact via payload.artifactId/artifactType.
 *
 * Links to the registered Artifacts tab route and passes the artifactId via
 * a query param so the Artifacts page auto-selects and opens the editor.
 * Project-scoped artifacts navigate to the project's Artifacts tab
 * (`?tab=artifacts&artifactId=…`); company-scoped artifacts navigate to the
 * company Artifacts route (`?artifactId=…`).
 */
export function ThreadArtifactCard({
  artifactId,
  artifactType,
  companyId,
  projectId,
}: {
  artifactId: string;
  artifactType: string;
  companyId: string;
  projectId?: string | null;
}) {
  const Icon = typeIcons[artifactType] ?? Link2;
  const label = typeLabels[artifactType] ?? artifactType;

  const to = projectId
    ? `/company/${companyId}/projects/${projectId}?tab=artifacts&artifactId=${encodeURIComponent(artifactId)}`
    : `/company/${companyId}/artifacts?artifactId=${encodeURIComponent(artifactId)}`;

  return (
    <Link
      to={to}
      data-testid="thread-artifact-card"
      data-artifact-id={artifactId}
      data-artifact-type={artifactType}
      className="mt-2 flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 transition-colors hover:border-accent/30 hover:bg-accent/[0.04]"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">{label} artifact</div>
        <div className="truncate text-xs text-text-muted">
          Click to open in {label} editor
        </div>
      </div>
      <Link2 className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
    </Link>
  );
}
