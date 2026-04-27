import { EventEmitter } from 'node:events';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Server event types
// ---------------------------------------------------------------------------

export interface ServerEvent {
  type: string;
  companyId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CompanyEvent extends ServerEvent {
  type:
    | 'company.created'
    | 'company.updated'
    | 'company.archived'
    | 'company.deleted';
}

export interface AgentEvent extends ServerEvent {
  type:
    | 'agent.created'
    | 'agent.updated'
    | 'agent.terminated'
    | 'agent.heartbeat'
    | 'agent.status_changed';
}

export interface ExecutionEvent extends ServerEvent {
  type:
    | 'execution.started'
    | 'execution.log'
    | 'execution.completed'
    | 'execution.recovery_created';
}

export interface EnvironmentEvent extends ServerEvent {
  type:
    | 'environment.created'
    | 'environment.updated'
    | 'environment.deleted';
}

export interface TaskEvent extends ServerEvent {
  type:
    | 'task.created'
    | 'task.updated'
    | 'task.assigned'
    | 'task.status_changed'
    | 'task.commented'
    | 'task.cancelled'
    | 'task.timed_out';
}

export interface ProjectEvent extends ServerEvent {
  type:
    | 'project.created'
    | 'project.updated'
    | 'project.deleted';
}

export interface GoalEvent extends ServerEvent {
  type:
    | 'goal.created'
    | 'goal.updated'
    | 'goal.deleted'
    | 'goal.progress_changed';
}

export interface MessageEvent extends ServerEvent {
  type: 'message.sent';
}

export interface BudgetEvent extends ServerEvent {
  type:
    | 'cost.recorded'
    | 'budget.alert'
    | 'budget.threshold_exceeded';
}

export interface WorkflowEvent extends ServerEvent {
  type:
    | 'workflow.created'
    | 'workflow.updated'
    | 'workflow.deleted'
    | 'workflow.started'
    | 'workflow.node_updated';
}

export interface ActivityEvent extends ServerEvent {
  type: 'activity.logged';
}

export type EidolonEvent =
  | CompanyEvent
  | AgentEvent
  | ProjectEvent
  | TaskEvent
  | GoalEvent
  | MessageEvent
  | BudgetEvent
  | WorkflowEvent
  | ActivityEvent
  | EnvironmentEvent
  | ExecutionEvent;

// ---------------------------------------------------------------------------
// Event bus singleton
// ---------------------------------------------------------------------------

class EventBus extends EventEmitter {
  private static instance: EventBus;

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Emit a typed event.  Automatically injects a timestamp if not present.
   */
  emitEvent(event: EidolonEvent): boolean {
    const enriched = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    logger.debug({ type: enriched.type, companyId: enriched.companyId }, 'Event emitted');
    return this.emit('event', enriched);
  }

  /**
   * Subscribe to all events for a specific company.
   */
  onEvent(handler: (event: EidolonEvent) => void): this {
    return this.on('event', handler);
  }

  /**
   * Subscribe to all events (one-time).
   */
  onceEvent(handler: (event: EidolonEvent) => void): this {
    return this.once('event', handler);
  }
}

export const eventBus = EventBus.getInstance();
export default eventBus;
