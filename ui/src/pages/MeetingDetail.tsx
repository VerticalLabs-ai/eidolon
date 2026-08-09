import { useState, useEffect, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, Sparkles, ListChecks, Trash2, Archive, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getMeeting,
  patchMeeting,
  attachTranscript,
  summarizeMeetingApi,
  extractActionItemsApi,
  getMeetingTasks,
  deleteMeeting,
  archiveMeeting,
  restoreMeeting,
} from "@/lib/api";
import { useServerEvents } from "@/lib/ws";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatDistanceToNow } from "date-fns";

export function MeetingDetail() {
  const { companyId, meetingId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState("");

  const meetingKey = ["meeting", companyId, meetingId];
  const tasksKey = ["meeting-tasks", companyId, meetingId];

  const { data: meetingRes, isLoading } = useQuery({
    queryKey: meetingKey,
    queryFn: () => getMeeting(companyId!, meetingId!),
    enabled: Boolean(companyId && meetingId),
  });
  const meeting = meetingRes?.data;

  const { data: tasksRes } = useQuery({
    queryKey: tasksKey,
    queryFn: () => getMeetingTasks(companyId!, meetingId!),
    enabled: Boolean(companyId && meetingId),
  });
  const tasks = tasksRes?.data ?? [];

  // Realtime: refresh on meeting.* events (VAL-MEETING-013)
  useServerEvents(companyId ?? "", "meeting.summary.created", () => {
    qc.invalidateQueries({ queryKey: meetingKey });
  });
  useServerEvents(companyId ?? "", "meeting.action_items.created", () => {
    qc.invalidateQueries({ queryKey: tasksKey });
    qc.invalidateQueries({ queryKey: meetingKey });
  });
  useServerEvents(companyId ?? "", "meeting.updated", () => {
    qc.invalidateQueries({ queryKey: meetingKey });
  });

  useEffect(() => {
    if (meeting) {
      setTitle(meeting.title);
      setTranscript(meeting.transcript ?? "");
    }
  }, [meeting?.id, meeting?.title, meeting?.transcript]);

  const saveTitleMutation = useMutation({
    mutationFn: (newTitle: string) =>
      patchMeeting(companyId!, meetingId!, { title: newTitle }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: meetingKey });
      toast.success("Title saved");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const attachTranscriptMutation = useMutation({
    mutationFn: (text: string) => attachTranscript(companyId!, meetingId!, text),
    onSuccess: (res) => {
      setTranscript(res.data.transcript ?? "");
      setEditingTranscript(false);
      qc.invalidateQueries({ queryKey: meetingKey });
      toast.success("Transcript attached");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Attach failed"),
  });

  const summarizeMutation = useMutation({
    mutationFn: () => summarizeMeetingApi(companyId!, meetingId!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: meetingKey });
      if (res.data.skipped) {
        toast.message("Summary skipped — no meaningful transcript");
      } else {
        toast.success("Summary generated");
      }
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Summarize failed"),
  });

  const actionItemsMutation = useMutation({
    mutationFn: () => extractActionItemsApi(companyId!, meetingId!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: tasksKey });
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      const count = res.data.tasks.length;
      if (res.data.skipped) {
        toast.message("No action items — transcript is empty");
      } else {
        toast.success(`Extracted ${count} action item${count === 1 ? "" : "s"}`);
      }
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Extraction failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMeeting(companyId!, meetingId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings", companyId] });
      toast.success("Meeting deleted");
      navigate(-1);
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveMeeting(companyId!, meetingId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: meetingKey });
      toast.success("Meeting archived");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Archive failed"),
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreMeeting(companyId!, meetingId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: meetingKey });
      toast.success("Meeting restored");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Restore failed"),
  });

  const handleSaveTitle = useCallback(() => {
    if (title.trim() && title !== meeting?.title) {
      saveTitleMutation.mutate(title.trim());
    }
  }, [title, meeting?.title, saveTitleMutation]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-text-secondary">Meeting not found.</p>
          <Link to={`/company/${companyId}/projects`} className="mt-2 inline-block text-xs text-accent hover:underline">
            Back
          </Link>
        </div>
      </div>
    );
  }

  const statusVariant: Record<string, "default" | "success" | "warning"> = {
    active: "success",
    archived: "default",
    deleted: "warning",
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-white/[0.06] bg-surface px-5 pt-4 pb-3">
        <div className="mb-2 flex items-center gap-3">
          <Link
            to={`/company/${companyId}/projects/${meeting.projectId ?? ""}?tab=meetings`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-accent hover:bg-accent/10 transition-all"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neon-cyan/15">
            <FileText className="h-4 w-4 text-neon-cyan" />
          </div>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleSaveTitle}
            aria-label="Meeting title"
            className="min-w-0 flex-1 bg-transparent text-lg font-bold text-text-primary font-display tracking-wide focus:outline-none focus:ring-1 focus:ring-accent/40 rounded"
          />
          <Badge variant={statusVariant[meeting.status] ?? "default"}>{meeting.status}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            loading={summarizeMutation.isPending}
            onClick={() => summarizeMutation.mutate()}
            disabled={meeting.status !== "active"}
          >
            Generate Summary
          </Button>
          <Button
            variant="secondary"
            icon={<ListChecks className="h-3.5 w-3.5" />}
            loading={actionItemsMutation.isPending}
            onClick={() => actionItemsMutation.mutate()}
            disabled={meeting.status !== "active"}
          >
            Extract Action Items
          </Button>
          {meeting.status === "active" ? (
            <>
              <Button
                variant="secondary"
                icon={<Archive className="h-3.5 w-3.5" />}
                onClick={() => archiveMutation.mutate()}
              >
                Archive
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => deleteMutation.mutate()}
              >
                Delete
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => restoreMutation.mutate()}
            >
              Restore
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Summary section */}
          <section className="rounded-xl border border-white/[0.06] bg-surface p-4" aria-label="Meeting summary">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-text-primary font-display">Summary</h2>
              {meeting.summaryGeneratedAt && (
                <span className="text-xs text-text-muted">
                  · {formatDistanceToNow(new Date(meeting.summaryGeneratedAt), { addSuffix: true })}
                </span>
              )}
            </div>
            {meeting.summary ? (
              <p className="text-sm leading-relaxed text-text-secondary whitespace-pre-wrap">{meeting.summary}</p>
            ) : (
              <p className="py-3 text-center text-sm text-text-muted" role="status">
                No summary yet. Click “Generate Summary” to create one from the transcript.
              </p>
            )}
          </section>

          {/* Transcript section */}
          <section className="rounded-xl border border-white/[0.06] bg-surface p-4" aria-label="Meeting transcript">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-text-muted" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-text-primary font-display">Transcript</h2>
              </div>
              {transcript && !editingTranscript && (
                <button
                  type="button"
                  onClick={() => {
                    setTranscriptDraft(transcript);
                    setEditingTranscript(true);
                  }}
                  className="text-xs font-medium text-accent hover:underline cursor-pointer"
                >
                  Replace transcript
                </button>
              )}
            </div>
            {editingTranscript ? (
              <div className="space-y-2">
                <textarea
                  value={transcriptDraft}
                  onChange={(e) => setTranscriptDraft(e.target.value)}
                  rows={10}
                  aria-label="Transcript text"
                  className="w-full rounded-md bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 resize-y"
                  placeholder="Paste the meeting transcript here…"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setEditingTranscript(false)}>Cancel</Button>
                  <Button
                    loading={attachTranscriptMutation.isPending}
                    onClick={() => attachTranscriptMutation.mutate(transcriptDraft)}
                    disabled={!transcriptDraft.trim()}
                  >
                    Attach Transcript
                  </Button>
                </div>
              </div>
            ) : transcript ? (
              <pre className="whitespace-pre-wrap rounded-md bg-white/[0.02] p-3 text-sm text-text-secondary font-mono max-h-80 overflow-auto">{transcript}</pre>
            ) : (
              <div className="space-y-2">
                <p className="py-3 text-center text-sm text-text-muted" role="status">
                  No transcript attached yet.
                </p>
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTranscriptDraft("");
                      setEditingTranscript(true);
                    }}
                  >
                    Paste Transcript
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* Action items section — links to real tasks */}
          <section className="rounded-xl border border-white/[0.06] bg-surface p-4" aria-label="Meeting action items">
            <div className="mb-2 flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-text-muted" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-text-primary font-display">Action Items</h2>
              <Badge variant="default">{tasks.length}</Badge>
            </div>
            {tasks.length === 0 ? (
              <p className="py-3 text-center text-sm text-text-muted" role="status">
                No action items extracted yet. Click “Extract Action Items” to create tasks from the transcript.
              </p>
            ) : (
              <ul className="space-y-2">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 rounded-md border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                    <span className="text-xs font-mono text-text-muted shrink-0">{t.identifier ?? ""}</span>
                    <Link
                      to={`/company/${companyId}/tasks/${t.id}`}
                      className="min-w-0 flex-1 truncate text-sm text-text-primary hover:text-accent hover:underline"
                    >
                      {t.title}
                    </Link>
                    <Badge variant="default">{t.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
