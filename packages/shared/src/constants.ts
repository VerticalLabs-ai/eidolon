// ---------------------------------------------------------------------------
// Eidolon - The AI Company Runtime -- Shared Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pagination defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE = 1;

// ---------------------------------------------------------------------------
// Budget & cost limits
// ---------------------------------------------------------------------------

/** Default monthly budget per company in cents ($100). */
export const DEFAULT_COMPANY_BUDGET_MONTHLY_CENTS = 10_000;

/** Default monthly budget per agent in cents ($10). */
export const DEFAULT_AGENT_BUDGET_MONTHLY_CENTS = 1_000;

/** Maximum monthly budget per company in cents ($100,000). */
export const MAX_COMPANY_BUDGET_MONTHLY_CENTS = 10_000_000;

/** Maximum monthly budget per agent in cents ($10,000). */
export const MAX_AGENT_BUDGET_MONTHLY_CENTS = 1_000_000;

/** Default budget alert thresholds (percent). */
export const DEFAULT_BUDGET_ALERT_THRESHOLDS = [50, 75, 90, 100] as const;

// ---------------------------------------------------------------------------
// Agent limits
// ---------------------------------------------------------------------------

/** Maximum agents per company. */
export const MAX_AGENTS_PER_COMPANY = 50;

/** Maximum capabilities per agent. */
export const MAX_CAPABILITIES_PER_AGENT = 20;

/** Maximum system prompt length in characters. */
export const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

/** Heartbeat interval in milliseconds (30 seconds). */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Threshold before considering an agent stale (2 minutes). */
export const AGENT_HEARTBEAT_STALE_MS = 120_000;

// ---------------------------------------------------------------------------
// Task limits
// ---------------------------------------------------------------------------

/** Maximum tags per task. */
export const MAX_TAGS_PER_TASK = 20;

/** Maximum dependencies per task. */
export const MAX_DEPENDENCIES_PER_TASK = 50;

/** Maximum description length. */
export const MAX_TASK_DESCRIPTION_LENGTH = 50_000;

/** Maximum title length. */
export const MAX_TASK_TITLE_LENGTH = 500;

// ---------------------------------------------------------------------------
// Workflow limits
// ---------------------------------------------------------------------------

/** Maximum nodes per workflow DAG. */
export const MAX_WORKFLOW_NODES = 200;

/** Maximum concurrent running workflows per company. */
export const MAX_CONCURRENT_WORKFLOWS = 10;

// ---------------------------------------------------------------------------
// Message limits
// ---------------------------------------------------------------------------

/** Maximum message content length. */
export const MAX_MESSAGE_CONTENT_LENGTH = 100_000;

/** Maximum subject length. */
export const MAX_MESSAGE_SUBJECT_LENGTH = 500;

// ---------------------------------------------------------------------------
// Token cost lookup (cents per 1M tokens -- approximate 2025 pricing)
// ---------------------------------------------------------------------------

export const TOKEN_COSTS_PER_MILLION = {
  // Anthropic
  'anthropic/claude-opus-4-6': { input: 1500, output: 7500 },
  'anthropic/claude-sonnet-4-6': { input: 300, output: 1500 },
  'anthropic/claude-haiku-4-5-20251001': { input: 80, output: 400 },
  // OpenAI
  'openai/gpt-5.4': { input: 250, output: 1000 },
  'openai/gpt-5.4-mini': { input: 40, output: 160 },
  'openai/gpt-5.4-nano': { input: 10, output: 40 },
  'openai/o3': { input: 1000, output: 4000 },
  'openai/o4-mini': { input: 110, output: 440 },
  // Google
  'google/gemini-3.1-pro-preview': { input: 125, output: 1000 },
  'google/gemini-3-flash-preview': { input: 15, output: 60 },
  'google/gemini-2.5-pro': { input: 125, output: 1000 },
  'google/gemini-2.5-flash': { input: 15, output: 60 },
  // Mistral
  'mistral/mistral-large-latest': { input: 200, output: 600 },
  // Ollama / Local (free - running locally)
  'ollama/gemma4': { input: 0, output: 0 },
  'ollama/llama3.2': { input: 0, output: 0 },
  'ollama/deepseek-r1': { input: 0, output: 0 },
  'ollama/qwen3': { input: 0, output: 0 },
  'ollama/mistral': { input: 0, output: 0 },
} as const;

export type KnownModel = keyof typeof TOKEN_COSTS_PER_MILLION;

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Maximum payload size for a single WebSocket message (64 KB). */
export const WS_MAX_PAYLOAD_BYTES = 65_536;

/** Server heartbeat interval over WebSocket (15 seconds). */
export const WS_HEARTBEAT_INTERVAL_MS = 15_000;

/** Client pong timeout before disconnect (10 seconds). */
export const WS_PONG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// HTTP / API
// ---------------------------------------------------------------------------

/** Default rate-limit: requests per 15-minute window per IP. */
export const RATE_LIMIT_REQUESTS_PER_WINDOW = 100;

/** Rate-limit window in milliseconds (15 minutes). */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Request body size limit (1 MB). */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

// ---------------------------------------------------------------------------
// Default agent model per provider
// ---------------------------------------------------------------------------

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
  google: 'gemini-3.1-pro-preview',
  mistral: 'mistral-large-latest',
  ollama: 'gemma4',
  custom: 'custom',
} as const;

// ---------------------------------------------------------------------------
// Goal defaults
// ---------------------------------------------------------------------------

export const DEFAULT_GOAL_PROGRESS = 0;
export const MAX_GOAL_PROGRESS = 100;
