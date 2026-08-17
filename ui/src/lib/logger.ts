/** Supported log levels. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** A single structured log entry. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

/** Logger interface used throughout the UI application. */
export interface Logger {
  error: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  debug: (message: string, context?: Record<string, unknown>) => void;
}

type ConsoleMethod = 'log' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Reserved field names that are set by the logger itself. Caller-supplied
 * context keys matching these are silently dropped to prevent overriding the
 * structured log entry's level, message, or timestamp.
 */
const RESERVED_FIELDS = new Set(['level', 'message', 'timestamp', 'time']);

/**
 * Strip reserved field names from caller-supplied context so they cannot
 * override the logger's own `level`, `message`, or `timestamp` fields.
 */
function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  const hasReserved = Object.keys(context).some((key) => RESERVED_FIELDS.has(key));
  if (!hasReserved) {
    return context;
  }
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!RESERVED_FIELDS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

const LEVEL_CONSOLE_METHOD: Record<LogLevel, ConsoleMethod> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
};

function formatDevLine(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const contextSuffix =
    context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  return `${timestamp} [${level.toUpperCase()}] ${message}${contextSuffix}`;
}

function writeProductionLog(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  const safeContext = sanitizeContext(context);
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(safeContext ?? {}),
  };
  // In production the logger emits newline-delimited JSON so logs can be
  // aggregated by Loki/CloudWatch/etc. This is the only intentional console
  // usage in the UI; application code should call logger.* instead.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function writeDevelopmentLog(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  const line = formatDevLine(level, message, sanitizeContext(context));
  const method = LEVEL_CONSOLE_METHOD[level];
  // Development output is human-readable and routed to the matching console
  // method. This is the only intentional console usage in the UI.
  // eslint-disable-next-line no-console
  console[method](line);
}

function createLogWriter(isProduction: boolean): Logger {
  return {
    error: (message, context) => {
      if (isProduction) {
        writeProductionLog('error', message, context);
      } else {
        writeDevelopmentLog('error', message, context);
      }
    },
    warn: (message, context) => {
      if (isProduction) {
        writeProductionLog('warn', message, context);
      } else {
        writeDevelopmentLog('warn', message, context);
      }
    },
    info: (message, context) => {
      if (isProduction) {
        writeProductionLog('info', message, context);
      } else {
        writeDevelopmentLog('info', message, context);
      }
    },
    debug: (message, context) => {
      if (isProduction) {
        writeProductionLog('debug', message, context);
      } else {
        writeDevelopmentLog('debug', message, context);
      }
    },
  };
}

/**
 * Create a structured logger.
 *
 * In production, writes newline-delimited JSON. In development, writes a
 * human-readable line to the console method matching the level.
 */
export function createLogger(options: { isProduction?: boolean } = {}): Logger {
  const isProduction = options.isProduction ?? import.meta.env.PROD;
  return createLogWriter(isProduction);
}

/** Default logger bound to the current build environment. */
export const logger = createLogger();
