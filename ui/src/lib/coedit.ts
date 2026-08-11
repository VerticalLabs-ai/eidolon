/**
 * Co-editing hooks for the UI (M3).
 *
 * Provides `useCoEditSession` which manages the WebSocket co-edit session
 * lifecycle (join/leave/reconnect), and `useCoEditCursors` which tracks
 * remote cursor/selection positions for display.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { wsClient, useWebSocket } from "./ws";
import type {
  CoEditOp,
  CoEditServerMsg,
} from "@eidolon/shared";
import { colorForUser } from "@eidolon/shared";

// ---------------------------------------------------------------------------
// Remote cursor state
// ---------------------------------------------------------------------------

export interface RemoteCursor {
  userId: string;
  name: string;
  color: string;
  position: number | { rowId: string; colKey: string } | { cardId: string } | null;
  selection: { start: number; end: number } | null;
}

// ---------------------------------------------------------------------------
// useCoEditSession
// ---------------------------------------------------------------------------

interface UseCoEditSessionOptions {
  companyId: string | undefined;
  artifactId: string | undefined;
  userId: string;
  name: string;
  /**
   * When false (default true), the hook does not join a co-edit session,
   * send ops/cursors, or process co-edit server messages. Used to disable
   * co-editing for artifact types that do not support op-based co-editing
   * (gallery, dashboard, app, slide_deck, timeline, code) so their saves
   * go through the standard LWW REST PATCH path.
   */
  enabled?: boolean;
  /** Called when a remote operation arrives — the editor applies it. */
  onRemoteOp?: (op: CoEditOp, userId: string) => void;
  /** Called when the session state is received (join/reconnect). */
  onStateSync?: (content: Record<string, unknown>, version: number) => void;
  /** Called when a save completes. */
  onSaved?: (version: number, content: Record<string, unknown>, title?: string) => void;
  /** Called when a user leaves (for cursor clearing). */
  onUserLeft?: (userId: string) => void;
}

export function useCoEditSession({
  companyId,
  artifactId,
  userId,
  name,
  enabled = true,
  onRemoteOp,
  onStateSync,
  onSaved,
  onUserLeft,
}: UseCoEditSessionOptions) {
  const { status: wsStatus } = useWebSocket(companyId);
  const [joined, setJoined] = useState(false);
  const [sessionVersion, setSessionVersion] = useState<number | null>(null);
  const joinedRef = useRef(false);

  // Keep callbacks in refs to avoid re-joining on every render
  const onRemoteOpRef = useRef(onRemoteOp);
  const onStateSyncRef = useRef(onStateSync);
  const onSavedRef = useRef(onSaved);
  const onUserLeftRef = useRef(onUserLeft);
  onRemoteOpRef.current = onRemoteOp;
  onStateSyncRef.current = onStateSync;
  onSavedRef.current = onSaved;
  onUserLeftRef.current = onUserLeft;

  // ── Join / re-join on connect ────────────────────────────────────────
  const doJoin = useCallback(() => {
    if (!artifactId || !companyId || !userId) return;
    if (wsClient.status !== "connected") return;
    wsClient.send({
      type: "coedit.join",
      artifactId,
      companyId,
      userId,
      name,
    });
  }, [artifactId, companyId, userId, name]);

  // Join when WS is connected and artifact changes
  useEffect(() => {
    if (!enabled) return;
    if (wsStatus !== "connected" || !artifactId || !companyId) return;
    doJoin();
  }, [wsStatus, artifactId, companyId, doJoin, enabled]);

  // ── Listen for co-edit server messages ───────────────────────────────
  useEffect(() => {
    if (!enabled || !artifactId) return;

    const unsubJoined = wsClient.subscribe("coedit.joined", (event) => {
      const msg = event as unknown as CoEditServerMsg;
      if (msg.type === "coedit.joined" && msg.artifactId === artifactId) {
        setJoined(true);
        joinedRef.current = true;
        setSessionVersion(msg.version);
        onStateSyncRef.current?.(msg.content, msg.version);
      }
    });

    const unsubOpBroadcast = wsClient.subscribe(
      "coedit.op.broadcast",
      (event) => {
        const msg = event as unknown as CoEditServerMsg;
        if (msg.type === "coedit.op.broadcast" && msg.artifactId === artifactId) {
          onRemoteOpRef.current?.(msg.op, msg.userId);
        }
      },
    );

    const unsubSaved = wsClient.subscribe("coedit.saved", (event) => {
      const msg = event as unknown as CoEditServerMsg;
      if (msg.type === "coedit.saved" && msg.artifactId === artifactId) {
        setSessionVersion(msg.version);
        onSavedRef.current?.(msg.version, msg.content, msg.title);
      }
    });

    const unsubUserLeft = wsClient.subscribe("coedit.user.left", (event) => {
      const msg = event as unknown as CoEditServerMsg;
      if (msg.type === "coedit.user.left" && msg.artifactId === artifactId) {
        onUserLeftRef.current?.(msg.userId);
      }
    });

    return () => {
      unsubJoined();
      unsubOpBroadcast();
      unsubSaved();
      unsubUserLeft();
    };
  }, [artifactId, enabled]);

  // ── Leave on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (artifactId && companyId && userId && joinedRef.current) {
        wsClient.send({
          type: "coedit.leave",
          artifactId,
          companyId,
          userId,
        });
      }
      joinedRef.current = false;
      setJoined(false);
    };
  }, [artifactId, companyId, userId]);

  // ── Re-join on reconnect ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      joinedRef.current = false;
      setJoined(false);
      return;
    }
    if (wsStatus === "connected" && artifactId && companyId && userId && !joinedRef.current) {
      doJoin();
    }
    if (wsStatus === "disconnected") {
      joinedRef.current = false;
      setJoined(false);
    }
  }, [wsStatus, artifactId, companyId, userId, doJoin, enabled]);

  // ── Actions ──────────────────────────────────────────────────────────
  const sendOp = useCallback(
    (op: CoEditOp) => {
      if (!enabled || !artifactId || !companyId) return;
      wsClient.send({
        type: "coedit.op",
        artifactId,
        companyId,
        userId,
        op,
      });
    },
    [enabled, artifactId, companyId, userId],
  );

  const sendCursor = useCallback(
    (position: RemoteCursor["position"]) => {
      if (!enabled || !artifactId || !companyId) return;
      wsClient.send({
        type: "coedit.cursor",
        artifactId,
        companyId,
        userId,
        name,
        position,
      });
    },
    [enabled, artifactId, companyId, userId, name],
  );

  const sendSelection = useCallback(
    (range: { start: number; end: number } | null) => {
      if (!enabled || !artifactId || !companyId) return;
      wsClient.send({
        type: "coedit.selection",
        artifactId,
        companyId,
        userId,
        name,
        range,
      });
    },
    [enabled, artifactId, companyId, userId, name],
  );

  const save = useCallback(
    (title?: string) => {
      if (!enabled || !artifactId || !companyId) return;
      wsClient.send({
        type: "coedit.save",
        artifactId,
        companyId,
        userId,
        ...(title !== undefined ? { title } : {}),
      });
    },
    [enabled, artifactId, companyId, userId],
  );

  return {
    joined,
    sessionVersion,
    wsConnected: wsStatus === "connected",
    sendOp,
    sendCursor,
    sendSelection,
    save,
  };
}

// ---------------------------------------------------------------------------
// useCoEditCursors — track remote cursors/selections
// ---------------------------------------------------------------------------

export function useCoEditCursors(artifactId: string | undefined) {
  const [cursors, setCursors] = useState<Map<string, RemoteCursor>>(
    new Map(),
  );

  useEffect(() => {
    if (!artifactId) return;

    const unsubCursor = wsClient.subscribe(
      "coedit.cursor.broadcast",
      (event) => {
        const msg = event as unknown as {
          type: string;
          artifactId: string;
          userId: string;
          name: string;
          color: string;
          position: RemoteCursor["position"];
        };
        if (msg.artifactId !== artifactId) return;
        setCursors((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.userId);
          next.set(msg.userId, {
            userId: msg.userId,
            name: msg.name,
            color: msg.color || colorForUser(msg.userId),
            position: msg.position,
            selection: existing?.selection ?? null,
          });
          return next;
        });
      },
    );

    const unsubSelection = wsClient.subscribe(
      "coedit.selection.broadcast",
      (event) => {
        const msg = event as unknown as {
          type: string;
          artifactId: string;
          userId: string;
          name: string;
          color: string;
          range: { start: number; end: number } | null;
        };
        if (msg.artifactId !== artifactId) return;
        setCursors((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.userId);
          next.set(msg.userId, {
            userId: msg.userId,
            name: msg.name,
            color: msg.color || colorForUser(msg.userId),
            position: existing?.position ?? null,
            selection: msg.range,
          });
          return next;
        });
      },
    );

    const unsubUserLeft = wsClient.subscribe("coedit.user.left", (event) => {
      const msg = event as unknown as {
        type: string;
        artifactId: string;
        userId: string;
      };
      if (msg.artifactId !== artifactId) return;
      setCursors((prev) => {
        const next = new Map(prev);
        next.delete(msg.userId);
        return next;
      });
    });

    return () => {
      unsubCursor();
      unsubSelection();
      unsubUserLeft();
    };
  }, [artifactId]);

  // Also clear cursors when artifactId changes
  useEffect(() => {
    setCursors(new Map());
  }, [artifactId]);

  return cursors;
}
