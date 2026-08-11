import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shared draft-sync hook for artifact editors (Doc / Sheet / Board)
// ---------------------------------------------------------------------------
//
// Bug this fixes: editors that compute `isDirty` by diffing local state
// against the LIVE artifact prop conflate "the user typed something" with
// "the artifact changed underneath us". When a realtime `artifact.updated`
// (or a co-edit op that updates the query cache) arrives on a CLEAN editor,
// the prop change makes `isDirty` flip to true, so the editor shows a false
// "This artifact changed elsewhere" banner instead of adopting the remote
// content.
//
// The correct pattern (originally in BoardEditor): keep a `baseline` ref of
// {id, title, serializedContent} representing the last state the editor and
// the server agreed on.
//   - isDirty       = local-vs-baseline  (NOT local-vs-live-prop)
//   - remoteChanged = incoming-vs-baseline
//   - clean + remoteChanged  -> adopt remote, advance baseline
//   - dirty  + remoteChanged  -> preserve draft, show conflict banner
//   - after a successful save -> reset baseline to what was saved so the
//     post-save refetch is not misread as a competing edit.
//
// Each editor provides:
//   - `localTitle` / `serializedLocalContent`: the current local state,
//     serialized to a string for comparison.
//   - `serializeArtifactContent`: serializes `artifact.content` into the same
//     string format so local and remote are comparable.
//   - `onAdoptRemote`: called when the editor should reset its local state to
//     match the incoming artifact (clean editor + remote change).
//   - `coediting`: when true, prop-based sync is skipped entirely (co-edit
//     mode applies remote ops via a ref callback, not through props). The
//     editor should still call `markSaved` after a co-edit save to advance
//     the baseline.
// ---------------------------------------------------------------------------

export interface UseArtifactDraftSyncOptions {
  /** The live artifact prop (may change via realtime refetch or co-edit cache update). */
  artifact: Artifact;
  /** Current local title state. */
  localTitle: string;
  /** Serialized current local content for comparison (same format as serializeArtifactContent). */
  serializedLocalContent: string;
  /** Serializes artifact.content into the same string format as serializedLocalContent. */
  serializeArtifactContent: (content: Record<string, unknown>) => string;
  /**
   * Called when the editor should adopt the remote artifact state (clean
   * editor + remote changed, or artifact switch). The editor resets its
   * local title/content state to match.
   */
  onAdoptRemote: (content: Record<string, unknown>, title: string) => void;
  /**
   * Co-editing mode: when true, the hook skips prop-based sync entirely.
   * Remote ops are applied via a ref callback, and saves update the prop to
   * match local state. The editor should call `markSaved` after a co-edit
   * save to advance the baseline.
   */
  coediting?: boolean;
}

export interface UseArtifactDraftSyncResult {
  /** True when local state differs from the baseline (last agreed state). */
  isDirty: boolean;
  /** True when a remote change arrived while the editor was dirty (show conflict banner). */
  remoteUpdate: boolean;
  /** Clear the remote-update banner. */
  clearRemoteUpdate: () => void;
  /**
   * Reset the baseline to the current artifact prop. Used after discarding a
   * draft to load the remote state.
   */
  resetBaselineToArtifact: () => void;
  /**
   * Reset the baseline to a saved snapshot so the post-save refetch is not
   * misread as a competing remote edit. Call this after a successful save
   * (both REST PATCH and co-edit flush).
   */
  markSaved: (title: string, content: Record<string, unknown>) => void;
}

export function useArtifactDraftSync({
  artifact,
  localTitle,
  serializedLocalContent,
  serializeArtifactContent,
  onAdoptRemote,
  coediting = false,
}: UseArtifactDraftSyncOptions): UseArtifactDraftSyncResult {
  const baseline = useRef({
    id: artifact.id,
    title: artifact.title,
    content: serializeArtifactContent(artifact.content),
    version: artifact.version,
  });
  const [remoteUpdate, setRemoteUpdate] = useState(false);

  // Keep callbacks in refs so the sync effect doesn't re-run when the
  // caller's callback identity changes. The logic is idempotent — if nothing
  // changed the effect returns early — but this avoids unnecessary re-runs.
  const onAdoptRemoteRef = useRef(onAdoptRemote);
  onAdoptRemoteRef.current = onAdoptRemote;
  const serializeRef = useRef(serializeArtifactContent);
  serializeRef.current = serializeArtifactContent;

  const isDirty =
    localTitle !== baseline.current.title ||
    serializedLocalContent !== baseline.current.content;

  // Watch the artifact prop for remote changes (realtime refetch, co-edit
  // cache update, or save). Decides whether to adopt or preserve the draft.
  useEffect(() => {
    const remoteSnapshot = serializeRef.current(artifact.content);
    const switchedArtifact = baseline.current.id !== artifact.id;

    if (coediting) {
      // Co-edit mode: remote ops are applied via a ref callback, not through
      // props. But we still need to advance the baseline when the version
      // changes — this happens after a co-edit save flush (including a REST
      // PATCH routed through the active session by the server). Without this,
      // a remote save would leave isDirty true (body updated by ops, baseline
      // stuck at the pre-save state).
      if (switchedArtifact) {
        baseline.current = {
          id: artifact.id,
          title: artifact.title,
          content: remoteSnapshot,
          version: artifact.version,
        };
        onAdoptRemoteRef.current(artifact.content, artifact.title);
        return;
      }
      if (artifact.version !== baseline.current.version) {
        baseline.current = {
          id: artifact.id,
          title: artifact.title,
          content: remoteSnapshot,
          version: artifact.version,
        };
      }
      return;
    }

    // Non-co-editing mode: adopt remote or preserve draft.
    const remoteChanged =
      artifact.title !== baseline.current.title ||
      remoteSnapshot !== baseline.current.content;
    if (!switchedArtifact && !remoteChanged) return;
    // A realtime refetch must not clobber an in-progress local draft.
    if (!switchedArtifact && isDirty) {
      setRemoteUpdate(true);
      return;
    }
    // Clean editor (or artifact switch): adopt remote and advance baseline.
    baseline.current = {
      id: artifact.id,
      title: artifact.title,
      content: remoteSnapshot,
      version: artifact.version,
    };
    onAdoptRemoteRef.current(artifact.content, artifact.title);
    setRemoteUpdate(false);
  }, [
    artifact.id,
    artifact.version,
    artifact.title,
    artifact.content,
    isDirty,
    coediting,
  ]);

  const clearRemoteUpdate = useCallback(() => setRemoteUpdate(false), []);

  const resetBaselineToArtifact = useCallback(() => {
    baseline.current = {
      id: artifact.id,
      title: artifact.title,
      content: serializeRef.current(artifact.content),
      version: artifact.version,
    };
    setRemoteUpdate(false);
  }, [artifact.id, artifact.title, artifact.content, artifact.version]);

  const markSaved = useCallback(
    (title: string, content: Record<string, unknown>) => {
      baseline.current = {
        id: artifact.id,
        title,
        content: serializeRef.current(content),
        version: artifact.version,
      };
      setRemoteUpdate(false);
    },
    [artifact.id, artifact.version],
  );

  return {
    isDirty,
    remoteUpdate,
    clearRemoteUpdate,
    resetBaselineToArtifact,
    markSaved,
  };
}
