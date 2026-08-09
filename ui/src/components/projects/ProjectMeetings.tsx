import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { FileText, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listProjectMeetings, createMeeting } from "@/lib/api";
import { useServerEvents } from "@/lib/ws";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatDistanceToNow } from "date-fns";

interface ProjectMeetingsProps {
  companyId: string;
  projectId: string;
}

export function ProjectMeetings({ companyId, projectId }: ProjectMeetingsProps) {
  const qc = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");

  const meetingsKey = ["meetings", companyId, projectId];
  const { data, isLoading } = useQuery({
    queryKey: meetingsKey,
    queryFn: () => listProjectMeetings(companyId, projectId, { status: "active" }),
    enabled: Boolean(companyId && projectId),
  });
  const meetings = data?.data ?? [];

  // Realtime: refresh on meeting.* events (VAL-MEETING-013)
  useServerEvents(companyId, "meeting.created", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });
  useServerEvents(companyId, "meeting.updated", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });
  useServerEvents(companyId, "meeting.summary.created", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });
  useServerEvents(companyId, "meeting.action_items.created", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });
  useServerEvents(companyId, "meeting.deleted", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });
  useServerEvents(companyId, "meeting.archived", () => {
    qc.invalidateQueries({ queryKey: ["meetings", companyId] });
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const createMutation = useMutation({
    mutationFn: () =>
      createMeeting(companyId, projectId, {
        title: title.trim(),
        transcript: transcript.trim() || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["meetings", companyId] });
      toast.success("Meeting created");
      setCreateOpen(false);
      setTitle("");
      setTranscript("");
      // Open the new meeting detail
      window.location.href = `/company/${companyId}/meetings/${res.data.id}`;
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Create failed"),
  });

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center justify-between">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold text-text-primary font-display focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
          >
            Meetings
          </h2>
          <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreateOpen(true)}>
            New Meeting
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          </div>
        ) : meetings.length === 0 ? (
          <div className="rounded-xl border border-white/[0.06] bg-surface p-8 text-center" role="status">
            <FileText className="mx-auto mb-2 h-8 w-8 text-text-muted" aria-hidden="true" />
            <p className="text-sm text-text-secondary">No meetings yet.</p>
            <p className="mt-1 text-xs text-text-muted">
              Create a meeting, paste a transcript, then generate a summary and action items.
            </p>
            <Button className="mt-3" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreateOpen(true)}>
              New Meeting
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {meetings.map((m) => (
              <li key={m.id}>
                <Link
                  to={`/company/${companyId}/meetings/${m.id}`}
                  className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-surface px-4 py-3 transition-colors hover:border-accent/30 hover:bg-accent/[0.03]"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neon-cyan/15">
                    <FileText className="h-4 w-4 text-neon-cyan" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{m.title}</p>
                    <p className="text-xs text-text-muted">
                      {formatDistanceToNow(new Date(m.updatedAt), { addSuffix: true })}
                      {m.summary ? " · summarized" : ""}
                      {m.transcript ? " · transcript" : ""}
                    </p>
                  </div>
                  {m.summary && (
                    <Sparkles className="h-3.5 w-3.5 text-accent shrink-0" aria-label="Has summary" />
                  )}
                  <Badge variant="default">{m.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="New meeting"
          onClick={() => setCreateOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-white/10 bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold text-text-primary font-display">New Meeting</h3>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">Title</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                  aria-label="Meeting title"
                  className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50"
                  placeholder="e.g. Weekly standup — 2026-08-09"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  Transcript (optional — paste now or attach later)
                </span>
                <textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  rows={6}
                  aria-label="Meeting transcript"
                  className="w-full rounded-md bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 resize-y"
                  placeholder="Paste the meeting transcript here…"
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button
                  loading={createMutation.isPending}
                  disabled={!title.trim()}
                  onClick={() => createMutation.mutate()}
                >
                  Create Meeting
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
