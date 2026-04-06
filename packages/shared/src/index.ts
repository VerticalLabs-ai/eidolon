// ---------------------------------------------------------------------------
// @eidolon/shared -- Public API
// ---------------------------------------------------------------------------

// Types & schemas --------------------------------------------------------
export * from './types/company.js';
export * from './types/agent.js';
export * from './types/task.js';
export * from './types/goal.js';
export * from './types/workflow.js';
export * from './types/message.js';
export * from './types/budget.js';
export * from './types/analytics.js';
export * from './types/events.js';

// Validators (re-exports schemas + common helpers) -----------------------
export {
  UuidSchema,
  PaginationSchema,
  SortDirectionSchema,
  DateRangeSchema,
  type PaginationInput,
  type SortDirection,
  type DateRange,
} from './validators.js';

// Constants --------------------------------------------------------------
export * from './constants.js';
