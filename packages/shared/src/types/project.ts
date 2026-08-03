// ---------------------------------------------------------------------------
// Project Home Summary — composed server-side from existing tables
// ---------------------------------------------------------------------------

import type { Task } from './task.js';
import type { File } from './file.js';

/** Minimal execution shape returned in the home summary's failedWork array. */
export interface HomeExecution {
  id: string;
  companyId: string;
  agentId: string;
  taskId: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal activity-log shape returned in the home summary's recentActivity array. */
export interface HomeActivityLog {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ProjectHomeSummary {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    repoUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  counts: {
    taskCount: number;
    goalCount: number;
    agentCount: number;
    fileCount: number;
  };
  taskStatusBreakdown: {
    backlog: number;
    todo: number;
    in_progress: number;
    review: number;
    done: number;
    cancelled: number;
    timed_out: number;
  };
  activeWork: Task[];
  needsAttention: Task[];
  failedWork: HomeExecution[];
  recentActivity: HomeActivityLog[];
  recentFiles: File[];
  goalProgress: {
    count: number;
    aggregateProgress: number;
  };
}
