import { FileText, Link2 } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Inline meeting card rendered in thread items when the agent's response
 * references a produced/summarized meeting via payload.meetingId
 * (VAL-MEETING-015). Links to the MeetingDetail route.
 */
export function ThreadMeetingCard({
  meetingId,
  companyId,
  projectId,
}: {
  meetingId: string;
  companyId: string;
  projectId?: string | null;
}) {
  const to = `/company/${companyId}/meetings/${encodeURIComponent(meetingId)}`;
  return (
    <Link
      to={to}
      data-testid="thread-meeting-card"
      data-meeting-id={meetingId}
      className="mt-2 flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 transition-colors hover:border-accent/30 hover:bg-accent/[0.04]"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-neon-cyan/15 text-neon-cyan">
        <FileText className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">Meeting</div>
        <div className="truncate text-xs text-text-muted">
          Click to open meeting summary &amp; action items
          {projectId ? " · project meeting" : ""}
        </div>
      </div>
      <Link2 className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
    </Link>
  );
}
