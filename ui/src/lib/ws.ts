import { useEffect, useRef, useState, useCallback } from "react";

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "disabled";

// WebSocket is a dev-only concern. The Vercel production deploy runs the
// API on Fluid Compute (stateless, request/response) so there is no long-
// running WS server to connect to. React Query's refetch cadence keeps
// data reasonably fresh; cross-user realtime moves to Supabase Realtime
// in a follow-up.
//
// Honors an explicit override via VITE_ENABLE_WEBSOCKET=1 so a self-
// hosted deploy with a long-running Node process can flip it back on.
const WS_ENABLED =
  import.meta.env.DEV ||
  (import.meta.env.VITE_ENABLE_WEBSOCKET as string | undefined) === "1";

interface ServerEvent {
  type: string;
  companyId: string;
  payload: unknown;
  timestamp: string;
}

type EventCallback = (event: ServerEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventCallback>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private _status: ConnectionStatus = "disconnected";
  private companyId: string | null = null;

  get status() {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  onStatusChange(fn: (status: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  connect(companyId: string) {
    if (!WS_ENABLED) {
      // Don't attempt a connection in production builds — avoids noisy
      // console errors on every page load. Status stays "disabled".
      this.companyId = companyId;
      this.setStatus("disabled");
      return;
    }

    if (this.companyId === companyId && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.disconnect();
    this.companyId = companyId;
    this.setStatus("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?companyId=${companyId}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
      };

      this.ws.onmessage = (event) => {
        try {
          const data: ServerEvent = JSON.parse(event.data);
          const typeListeners = this.listeners.get(data.type);
          if (typeListeners) {
            typeListeners.forEach((fn) => fn(data));
          }
          const allListeners = this.listeners.get("*");
          if (allListeners) {
            allListeners.forEach((fn) => fn(data));
          }
        } catch {
          // ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.setStatus("disconnected");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus("error");
      };
    } catch {
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (!this.companyId) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      if (this.companyId) {
        this.connect(this.companyId);
      }
    }, delay);
  }

  subscribe(eventType: string, callback: EventCallback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);

    return () => {
      const set = this.listeners.get(eventType);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.listeners.delete(eventType);
      }
    };
  }
}

// Singleton
const wsClient = new WebSocketClient();

export function useWebSocket(companyId: string | undefined) {
  const [status, setStatus] = useState<ConnectionStatus>(wsClient.status);

  useEffect(() => {
    if (!companyId) return;

    wsClient.connect(companyId);
    const unsub = wsClient.onStatusChange(setStatus);

    return () => {
      unsub();
    };
  }, [companyId]);

  return { status };
}

export function useServerEvents(
  companyId: string | undefined,
  eventType: string,
  callback: EventCallback,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const stableCallback = useCallback((event: ServerEvent) => {
    callbackRef.current(event);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    return wsClient.subscribe(eventType, stableCallback);
  }, [companyId, eventType, stableCallback]);
}

export { wsClient };
export type { ConnectionStatus, ServerEvent };
