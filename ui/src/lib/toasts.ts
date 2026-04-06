import { useCallback } from "react";
import { toast } from "sonner";
import { useServerEvents } from "./ws";

interface EventPayload {
  title?: string;
  name?: string;
  status?: string;
  message?: string;
  agent?: string;
  agentName?: string;
  [key: string]: unknown;
}

/**
 * Hook that listens to WebSocket events and shows toast notifications.
 * Call once in AppShell — it handles all event types.
 */
export function useEventToasts(companyId: string | undefined) {
  const handler = useCallback(
    (event: { type: string; payload: unknown }) => {
      const p = (event.payload ?? {}) as EventPayload;

      switch (event.type) {
        case "task.created":
          toast("New issue created", {
            description: p.title ?? "A new issue was added",
          });
          break;

        case "task.status_changed":
          toast("Issue updated", {
            description: `"${p.title ?? "Issue"}" moved to ${p.status ?? "new status"}`,
          });
          break;

        case "agent.status_changed":
          toast("Agent status changed", {
            description: `${p.name ?? p.agentName ?? "Agent"} is now ${p.status ?? "updated"}`,
          });
          break;

        case "execution.completed":
          toast.success("Execution completed", {
            description: `${p.agentName ?? p.agent ?? "Agent"} finished execution`,
          });
          break;

        case "execution.failed":
          toast.error("Execution failed", {
            description: `${p.agentName ?? p.agent ?? "Agent"} encountered an error`,
          });
          break;

        case "budget.alert":
          toast.warning("Budget alert", {
            description: p.message ?? "A budget threshold was reached",
          });
          break;

        case "project.created":
          toast("New project created", {
            description: p.name ?? p.title ?? "A new project was added",
          });
          break;

        case "agent.created":
          toast("New agent hired", {
            description: p.name ?? "A new agent joined the company",
          });
          break;

        default:
          break;
      }
    },
    [],
  );

  useServerEvents(companyId, "*", handler);
}
