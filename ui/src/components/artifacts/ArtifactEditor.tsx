import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Grid3x3, LayoutGrid, Presentation, GanttChartSquare, Images, BarChart3, AppWindow, Code2, AlertCircle, RotateCcw, Copy, Shield, Lock, Trash2, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Input";
import { DocEditor, type ConflictState as DocConflictState } from "./DocEditor";
import { SheetEditor } from "./SheetEditor";
import { BoardEditor } from "./BoardEditor";
import { SlideEditor } from "./SlideEditor";
import { TimelineEditor } from "./TimelineEditor";
import { GalleryEditor } from "./GalleryEditor";
import { DashboardEditor } from "./DashboardEditor";
import { AppEditor } from "./AppEditor";
import { CodeEditor } from "./CodeEditor";
import { RevisionHistory } from "./RevisionHistory";
import { LinksPanel } from "./LinksPanel";
import { DiffModal } from "./DiffModal";
import { PresenceIndicator } from "./PresenceIndicator";
import { CoEditCursorOverlay } from "./CoEditCursorOverlay";
import { SaveArtifactTemplateModal } from "./SaveArtifactTemplateModal";
import { PermissionManager } from "./PermissionManager";
import { MfaChallengeModal } from "@/components/security/MfaChallengeModal";
import {
  useArtifact,
  useUpdateArtifact,
  useArtifactRevisions,
  useRestoreRevision,
  useArtifactPresence,
  usePresenceActions,
  useSaveArtifactTemplate,
  useResolvePermission,
  useProjects,
  useLinks,
} from "@/lib/hooks";
import { useMfaStepUp, isMfaStepUpRequired } from "@/lib/useMfaStepUp";
import { useServerEvents } from "@/lib/ws";
import { useWebSocket } from "@/lib/ws";
import { useCoEditSession, useCoEditCursors } from "@/lib/coedit";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, permanentlyDeleteArtifact, transferArtifactOwnership } from "@/lib/api";
import type { ArtifactType, Artifact } from "@/lib/api";
import { setDirtyEditorGuard } from "@/lib/dirty-editor";
import { applyOp, isCoEditableType } from "@eidolon/shared";
import type { CoEditOp } from "@eidolon/shared";

/** Header labels for the artifact types that have a dedicated editor. */
const EDITOR_TYPE_LABELS: Partial<Record<ArtifactType, string>> = {
  document: "Document",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
  timeline: "Timeline",
  gallery: "Gallery",
  dashboard: "Dashboard",
  app: "App",
  code: "Code",
};

interface ArtifactEditorProps {
  companyId: string;
  artifactId: string;
  projectId?: string;
  onBack: () => void;
}

export function ArtifactEditor({
  companyId,
  artifactId,
  onBack,
}: ArtifactEditorProps) {
  const { data: artifact, isLoading, isError, refetch } = useArtifact(
    companyId,
    artifactId,
  );
  const { data: revisions } = useArtifactRevisions(companyId, artifactId);
  // ── Smart artifact linking (M3) ───────────────────────────────────────
  // Fetches the link graph when the editor opens. The query key includes
  // the artifactId so navigating to a different artifact re-fetches
  // automatically (VAL-LINK-038/039).
  const linksQuery = useLinks(companyId, artifactId);
  const updateMutation = useUpdateArtifact(companyId);
  const restoreMutation = useRestoreRevision(companyId);
  const saveArtifactTemplateMutation = useSaveArtifactTemplate(companyId);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [permManagerOpen, setPermManagerOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState<string>("");
  const [transferBusy, setTransferBusy] = useState(false);
  const mfa = useMfaStepUp();
  const { data: projects } = useProjects(companyId);
  const { status: wsStatus } = useWebSocket(companyId);
  const qc = useQueryClient();

  // ── Revision diff (M2) ──────────────────────────────────────────────────
  // The diff modal is driven by the `?diff=v1-v2` URL query param so the view
  // is shareable/bookmarkable (VAL-DIFF-061/064). Opening the modal via the
  // Compare button sets the param; closing removes it. Direct navigation to
  // `?diff=v1-v2` opens the modal automatically.
  const [searchParams, setSearchParams] = useSearchParams();
  const diffParam = searchParams.get("diff");
  const diffVersions: [number, number] | null = (() => {
    if (!diffParam) return null;
    const m = /^(\d+)-(\d+)$/.exec(diffParam);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isInteger(a) || a < 1 || !Number.isInteger(b) || b < 1) return null;
    return [a, b];
  })();
  const diffOpen = diffVersions !== null;

  const openDiff = useCallback(
    (v1: number, v2: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("diff", `${v1}-${v2}`);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const closeDiff = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("diff");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── RBAC (M4): resolve the acting user's access level on this artifact ─
  // view → read-only editor; edit → can edit; manage → can edit + manage
  // permissions + delete. null → hidden (shouldn't reach the editor; the
  // list filters hidden artifacts, and the API returns 403 on direct GET).
  const { data: permData } = useResolvePermission(companyId, "artifact", artifactId);
  const accessLevel = permData?.accessLevel ?? null;
  const canManage = accessLevel === "manage";

  // ── Presence (M3) ──────────────────────────────────────────────────────
  // Join on open, leave on unmount. The presence list is live-patched by WS
  // events (presence.join/leave/typing) so indicators appear/clear without a
  // reload. Typing is detected via input/keydown events bubbling to the
  // editor container (no per-editor wiring needed).
  const { data: presence } = useArtifactPresence(companyId, artifactId);
  const { join: joinPresence, leave: leavePresence, notifyTyping, selfUserId } =
    usePresenceActions(companyId, artifactId);

  useEffect(() => {
    if (!companyId || !artifactId) return;
    void joinPresence();
    return () => {
      void leavePresence();
    };
  }, [companyId, artifactId, joinPresence, leavePresence]);

  const handlePresenceInput = useCallback(() => {
    void notifyTyping();
  }, [notifyTyping]);

  // ── Co-editing (M3) ───────────────────────────────────────────────────
  // Join the co-edit session on open. Remote operations are applied to the
  // editor's local state via a ref callback (not through the query cache,
  // which would conflict with the editor's draft-sync logic). The cache is
  // also updated for other components (artifact list, etc.).
  const applyRemoteOpRef = useRef<((op: CoEditOp) => void) | null>(null);
  // Only enable op-based co-editing for types that have granular op handlers
  // (document, sheet, board). M5 types (gallery, dashboard, app) and other
  // non-listed types do not support co-editing — their saves go through the
  // standard LWW REST PATCH path. Creating a co-edit session for them would
  // cause mergeExternalUpdate to produce empty ops and silently discard
  // content changes while the version increments.
  const coeditEnabled = artifact ? isCoEditableType(artifact.type) : false;
  const coedit = useCoEditSession({
    companyId,
    artifactId,
    userId: selfUserId ?? "dev-user-000",
    name: "You",
    enabled: coeditEnabled,
    onRemoteOp: useCallback((op: CoEditOp, _userId: string) => {
      // Apply to editor's local state via the ref callback
      applyRemoteOpRef.current?.(op);
      // Also update the query cache for other components (list, etc.).
      // Compute newContent INSIDE the updater using `old.content` (not the
      // closure `artifact.content`) so rapid successive remote ops don't
      // stack on a stale snapshot.
      qc.setQueryData(["artifacts", companyId, artifactId], (old: Artifact | undefined) => {
        if (!old) return old;
        const newContent = applyOp(old.type, old.content, op);
        return { ...old, content: newContent };
      });
    }, [companyId, artifactId, qc]),
    onStateSync: useCallback((content: Record<string, unknown>, version: number) => {
      qc.setQueryData(["artifacts", companyId, artifactId], (old: Artifact | undefined) => {
        if (!old) return old;
        return { ...old, content, version };
      });
    }, [companyId, artifactId, qc]),
    onSaved: useCallback((version: number, content: Record<string, unknown>, title?: string) => {
      qc.setQueryData(["artifacts", companyId, artifactId], (old: Artifact | undefined) => {
        if (!old) return old;
        return { ...old, content, version, ...(title !== undefined ? { title } : {}) };
      });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId, artifactId, "revisions"] });
    }, [companyId, artifactId, qc]),
  });
  const remoteCursors = useCoEditCursors(artifactId);

  // Also leave presence beforeunload (tab close) — best-effort.
  useEffect(() => {
    if (!companyId || !artifactId) return;
    const onBeforeUnload = () => {
      // sendBeacon isn't trivially available for JSON POST with credentials;
      // the server stale-sweep (90s TTL) handles this case. This is a
      // best-effort enhancement only.
      void leavePresence();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [companyId, artifactId, leavePresence]);

  const [conflict, setConflict] = useState<
    (DocConflictState & { type?: ArtifactType }) | null
  >(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the back button when the editor opens so keyboard users can
  // Tab through the editor controls (VAL-ART-065/VAL-CROSS-017).
  useEffect(() => {
    if (!isLoading && artifact) {
      backBtnRef.current?.focus();
    }
  }, [isLoading, artifact]);

  useEffect(() => () => setDirtyEditorGuard(null), []);

  // Realtime: listen for artifact.updated and artifact.deleted to refresh
  useServerEvents(companyId, "artifact.updated", (event) => {
    const payload = event.payload as { artifact?: { id: string } };
    if (payload?.artifact?.id === artifactId) {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId, artifactId] });
      qc.invalidateQueries({
        queryKey: ["artifacts", companyId, artifactId, "revisions"],
      });
    }
  });

  useServerEvents(companyId, "artifact.revision.created", (event) => {
    const payload = event.payload as { artifactId?: string };
    if (payload?.artifactId === artifactId) {
      qc.invalidateQueries({
        queryKey: ["artifacts", companyId, artifactId, "revisions"],
      });
    }
  });

  useServerEvents(companyId, "artifact.deleted", (event) => {
    const payload = event.payload as { artifact?: { id: string } };
    if (payload?.artifact?.id === artifactId) {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId, artifactId] });
    }
  });

  // Clear conflict when the artifact data changes via realtime
  useEffect(() => {
    if (artifact && conflict && artifact.version > conflict.currentVersion) {
      // The conflict was resolved (someone saved a newer version than what we
      // conflicted with); clear it so the user can save against the new base.
      setConflict(null);
    }
  }, [artifact, conflict]);

  const handleSave = useCallback(
    async (data: { title: string; content: Record<string, unknown> }) => {
      if (!artifact) return;
      setConflict(null);
      try {
        await updateMutation.mutateAsync({
          id: artifactId,
          version: artifact.version,
          title: data.title,
          content: data.content,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as {
            details?: {
              current?: {
                version: number;
                title: string;
                content: Record<string, unknown>;
              };
            };
            current?: {
              version: number;
              title: string;
              content: Record<string, unknown>;
            };
          };
          const current = body?.details?.current ?? body?.current;
          if (current) {
            setConflict({
              currentVersion: current.version,
              currentTitle: current.title,
              currentContent: current.content,
            });
            // Refresh the cached artifact version so "Save again to
            // overwrite" actually succeeds on the next attempt instead of
            // looping on the stale version. The editors preserve the local
            // draft because their useEffect sees isDirty and only sets
            // remoteUpdate (which is hidden while conflictState is set).
            qc.setQueryData(["artifacts", companyId, artifactId], (old: Artifact | undefined) => {
              if (!old) return old;
              return {
                ...old,
                version: current.version,
                title: current.title,
                content: current.content,
              };
            });
          }
        }
        throw err;
      }
    },
    [artifact, artifactId, updateMutation, qc, companyId],
  );

  const handleRestore = useCallback(
    async (version: number) => {
      if (!artifact) return;
      setConflict(null);
      try {
        await restoreMutation.mutateAsync({ id: artifactId, version });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as {
            details?: {
              current?: {
                version: number;
                title: string;
                content: Record<string, unknown>;
              };
            };
            current?: {
              version: number;
              title: string;
              content: Record<string, unknown>;
            };
          };
          const current = body?.details?.current ?? body?.current;
          if (current) {
            setConflict({
              currentVersion: current.version,
              currentTitle: current.title,
              currentContent: current.content,
            });
            qc.setQueryData(["artifacts", companyId, artifactId], (old: Artifact | undefined) => {
              if (!old) return old;
              return {
                ...old,
                version: current.version,
                title: current.title,
                content: current.content,
              };
            });
          }
        }
      }
    },
    [artifact, artifactId, restoreMutation, qc, companyId],
  );

  const handleDiscardConflict = () => {
    setConflict(null);
    refetch();
  };

  // VAL-SEC-002/003/008: permanent artifact delete + ownership transfer are
  // step-up gated. The first attempt is made without a step-up token; the
  // server responds 403 MFA_STEP_UP_REQUIRED and we open the MfaChallengeModal.
  // A valid TOTP code obtains a step-up token and retries the gated operation.
  // Dismissing the modal abandons the action (no mutation — VAL-SEC-003).
  const handlePermanentDelete = useCallback(async () => {
    if (!artifact) return;
    if (
      !confirm(
        `Permanently delete "${artifact.title}"? This removes all revisions and cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await permanentlyDeleteArtifact(companyId, artifactId, "");
    } catch (err) {
      if (isMfaStepUpRequired(err)) {
        mfa.challenge({
          actionLabel: `Permanently delete artifact "${artifact.title}"`,
          scope: "artifact_permanent_delete",
          companyId,
          onStepUp: async (token) => {
            await permanentlyDeleteArtifact(companyId, artifactId, token);
            toast.success("Artifact permanently deleted");
            qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
            onBack();
          },
        });
      } else {
        const msg = err instanceof Error ? err.message : "Delete failed";
        toast.error(msg);
      }
    }
  }, [artifact, companyId, artifactId, mfa, qc, onBack]);

  const openTransfer = useCallback(() => {
    if (!artifact) return;
    setTransferTarget(artifact.projectId ?? "");
    setTransferOpen(true);
  }, [artifact]);

  const handleTransferSubmit = useCallback(async () => {
    if (!artifact) return;
    const targetProjectId =
      transferTarget === "" ? null : transferTarget;
    setTransferBusy(true);
    try {
      // Attempt without a step-up token first → expect 403 MFA_STEP_UP_REQUIRED.
      await transferArtifactOwnership(
        companyId,
        artifactId,
        targetProjectId,
        "",
      );
    } catch (err) {
      if (isMfaStepUpRequired(err)) {
        mfa.challenge({
          actionLabel: `Transfer ownership of "${artifact.title}"`,
          scope: "artifact_transfer",
          companyId,
          onStepUp: async (token) => {
            const res = await transferArtifactOwnership(
              companyId,
              artifactId,
              targetProjectId,
              token,
            );
            qc.setQueryData(["artifacts", companyId, artifactId], res.data);
            qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
            toast.success("Ownership transferred");
            setTransferOpen(false);
          },
        });
      } else {
        const msg = err instanceof Error ? err.message : "Transfer failed";
        toast.error(msg);
      }
    } finally {
      setTransferBusy(false);
    }
  }, [artifact, companyId, artifactId, transferTarget, mfa, qc]);

  const handleEditorState = useCallback(
    (state: { dirty: boolean; save: () => Promise<boolean>; discard: () => void }) => {
      setDirtyEditorGuard({
        isDirty: () => state.dirty,
        save: state.save,
        discard: state.discard,
      });
    },
    [],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (isError || !artifact) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<AlertCircle className="h-6 w-6" />}
          title="Artifact not found"
          description="This artifact may have been deleted or does not exist."
          action={
            <Button variant="secondary" onClick={onBack} icon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Back to Artifacts
            </Button>
          }
        />
      </div>
    );
  }

  if (artifact.status === "deleted") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<AlertCircle className="h-6 w-6" />}
          title="Artifact deleted"
          description="This artifact has been deleted."
          action={
            <Button variant="secondary" onClick={onBack} icon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Back to Artifacts
            </Button>
          }
        />
      </div>
    );
  }

  const conflictState = conflict
    ? {
        currentVersion: conflict.currentVersion,
        currentTitle: conflict.currentTitle,
        currentContent: conflict.currentContent,
      }
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* Editor header with back button */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
        <button
          ref={backBtnRef}
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-accent hover:bg-accent/10 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Back to artifacts list"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
          {artifact.type === "document" ? (
            <FileText className="h-3.5 w-3.5" />
          ) : artifact.type === "board" ? (
            <LayoutGrid className="h-3.5 w-3.5" />
          ) : artifact.type === "slide_deck" ? (
            <Presentation className="h-3.5 w-3.5" />
          ) : artifact.type === "timeline" ? (
            <GanttChartSquare className="h-3.5 w-3.5" />
          ) : artifact.type === "gallery" ? (
            <Images className="h-3.5 w-3.5" />
          ) : artifact.type === "dashboard" ? (
            <BarChart3 className="h-3.5 w-3.5" />
          ) : artifact.type === "app" ? (
            <AppWindow className="h-3.5 w-3.5" />
          ) : artifact.type === "code" ? (
            <Code2 className="h-3.5 w-3.5" />
          ) : (
            <Grid3x3 className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="text-xs text-text-secondary">
          {EDITOR_TYPE_LABELS[artifact.type] ?? artifact.type}
        </span>
        {/* Presence indicators (M3) — other viewers + typing, live via WS */}
        {presence && presence.length > 0 && (
          <div className="ml-auto">
            <PresenceIndicator
              presence={presence}
              selfUserId={selfUserId}
              artifactKind={EDITOR_TYPE_LABELS[artifact.type] ?? artifact.type}
            />
          </div>
        )}
        {conflict && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="h-3 w-3" />}
            onClick={handleDiscardConflict}
            className={presence && presence.length > 0 ? "" : "ml-auto"}
          >
            Discard & Reload
          </Button>
        )}
        {/* Save as Template (M4) — captures this artifact's type + content as
            a reusable artifact template (VAL-TEMPLATE-005). */}
        <button
          type="button"
          onClick={() => setSaveTemplateOpen(true)}
          disabled={saveArtifactTemplateMutation.isPending}
          title="Save as artifact template"
          aria-label="Save as template"
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-medium text-text-secondary hover:text-accent hover:border-accent/30 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <Copy className="h-3 w-3" />
          Save as Template
        </button>
        {/* Permission manager (M4 RBAC) — manage-capable users can grant/revoke. */}
        {canManage && (
          <button
            type="button"
            onClick={() => setPermManagerOpen(true)}
            title="Manage permissions"
            aria-label="Manage permissions"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-medium text-text-secondary hover:text-accent hover:border-accent/30 transition-colors cursor-pointer"
          >
            <Shield className="h-3 w-3" />
            Permissions
          </button>
        )}
        {/* Transfer ownership (M8 step-up gated) — move the artifact to another
            project or company-level. Requires step-up re-authentication. */}
        {canManage && (
          <button
            type="button"
            onClick={openTransfer}
            title="Transfer ownership"
            aria-label="Transfer ownership"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-medium text-text-secondary hover:text-accent hover:border-accent/30 transition-colors cursor-pointer"
          >
            <ArrowRightLeft className="h-3 w-3" />
            Transfer
          </button>
        )}
        {/* Permanently delete (M8 step-up gated) — hard-deletes the artifact
            and all revisions. Requires step-up re-authentication. */}
        {canManage && (
          <button
            type="button"
            onClick={handlePermanentDelete}
            title="Permanently delete"
            aria-label="Permanently delete"
            className="inline-flex items-center gap-1 rounded-md border border-error/20 px-2 py-1 text-xs font-medium text-error/80 hover:text-error hover:border-error/40 hover:bg-error/10 transition-colors cursor-pointer"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        )}
        {permManagerOpen && (
          <PermissionManager
            companyId={companyId}
            resourceType="artifact"
            resourceId={artifactId}
            resourceLabel={artifact.title}
            onClose={() => setPermManagerOpen(false)}
          />
        )}
        {/* Read-only indicator (M4 RBAC) — view-only users see a badge. */}
        {accessLevel === "view" && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-400">
            <Lock className="h-3 w-3" />
            Read-only
          </span>
        )}
        {saveTemplateOpen && (
          <SaveArtifactTemplateModal
            artifactTitle={artifact.title}
            typeLabel={EDITOR_TYPE_LABELS[artifact.type] ?? artifact.type}
            pending={saveArtifactTemplateMutation.isPending}
            onCancel={() => setSaveTemplateOpen(false)}
            onSubmit={async (name, description) => {
              try {
                await saveArtifactTemplateMutation.mutateAsync({
                  artifactId: artifact.id,
                  name,
                  description: description || null,
                });
                toast.success("Artifact template saved");
                setSaveTemplateOpen(false);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Save failed";
                toast.error(msg);
              }
            }}
          />
        )}
        {/* Transfer ownership modal (M8 step-up gated). Picking a target
            project (or company-level) and confirming triggers the step-up
            challenge via handleTransferSubmit. */}
        {transferOpen && (
          <Modal
            open={transferOpen}
            onClose={() => setTransferOpen(false)}
            title="Transfer ownership"
            dismissible={!transferBusy}
          >
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                Move <strong className="text-text-primary">{artifact.title}</strong>{" "}
                to another project, or to company-level (no project). This
                requires step-up re-authentication.
              </p>
              <Select
                label="Destination"
                value={transferTarget}
                onChange={(e) => setTransferTarget(e.target.value)}
                disabled={transferBusy}
                options={[
                  { value: "", label: "Company level (no project)" },
                  ...((projects ?? []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  }))),
                ]}
              />
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setTransferOpen(false)}
                  disabled={transferBusy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleTransferSubmit}
                  loading={transferBusy}
                >
                  Transfer
                </Button>
              </div>
            </div>
          </Modal>
        )}
        {/* MFA challenge modal (M8 step-up) — opened when a sensitive action
            (permanent delete / ownership transfer) receives 403
            MFA_STEP_UP_REQUIRED. A valid TOTP code obtains a step-up token and
            retries the gated operation; dismissing abandons the action. */}
        <MfaChallengeModal {...mfa.modalProps} />
      </div>

      {/* Editor + revision history */}
      <div className="flex flex-1 overflow-hidden">
        <div
          className="relative flex-1 overflow-hidden"
          onInput={handlePresenceInput}
          onKeyDown={handlePresenceInput}
          style={accessLevel === "view" ? { pointerEvents: "none" } : undefined}
          aria-readonly={accessLevel === "view"}
        >
          <CoEditCursorOverlay cursors={remoteCursors} selfUserId={selfUserId} />
          {artifact.type === "document" ? (
            <DocEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
              coeditSendOp={coedit.joined ? coedit.sendOp : undefined}
              coeditSendCursor={coedit.joined ? coedit.sendCursor : undefined}
              coeditSave={coedit.joined ? coedit.save : undefined}
              applyRemoteOpRef={coedit.joined ? applyRemoteOpRef : undefined}
            />
          ) : artifact.type === "sheet" ? (
            <SheetEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "board" ? (
            <BoardEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "slide_deck" ? (
            <SlideEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "timeline" ? (
            <TimelineEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "gallery" ? (
            <GalleryEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "dashboard" ? (
            <DashboardEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "app" ? (
            <AppEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : artifact.type === "code" ? (
            <CodeEditor
              artifact={artifact}
              version={artifact.version}
              onSave={handleSave}
              saving={updateMutation.isPending}
              conflictState={conflictState}
              wsConnected={wsStatus === "connected"}
              onStateChange={handleEditorState}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={<AlertCircle className="h-6 w-6" />}
                title="Unsupported type"
                description={`Artifact type "${artifact.type}" does not have an editor yet.`}
              />
            </div>
          )}
        </div>

        {/* Sidebar: revision history (top) + links panel (bottom).
            The sidebar always renders so the Links panel is visible for any
            artifact (VAL-LINK-028). When no revisions exist, only the
            Links panel is shown. */}
        <aside className="flex w-64 shrink-0 flex-col border-l border-white/[0.06] bg-surface/60">
          {revisions && revisions.length > 0 && (
            <div className="flex-1 overflow-hidden">
              <RevisionHistory
                revisions={revisions}
                currentVersion={artifact.version}
                onRestore={handleRestore}
                restoring={restoreMutation.isPending}
                readOnly={!canManage}
                onCompare={openDiff}
              />
            </div>
          )}
          <LinksPanel
            companyId={companyId}
            artifactId={artifactId}
            links={linksQuery.data}
            isLoading={linksQuery.isLoading}
            isError={linksQuery.isError}
          />
        </aside>
      </div>

      {/* Revision diff modal (M2) — driven by ?diff=v1-v2 so it is
          shareable/bookmarkable and opens on direct URL navigation. */}
      <DiffModal
        open={diffOpen}
        onClose={closeDiff}
        companyId={companyId}
        artifactId={artifactId}
        v1={diffVersions ? diffVersions[0] : 1}
        v2={diffVersions ? diffVersions[1] : 1}
      />
    </div>
  );
}
