/**
 * Structured logger for server-side code.
 *
 * - Development: human-readable console output (same as console.log)
 * - Production: JSON-structured output for log aggregation
 *
 * No external dependency — upgrade to pino later for advanced features.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type ConsoleWriter = (...args: unknown[]) => void;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const isProduction = process.env.NODE_ENV === 'production';
const minLevel = LOG_LEVELS[
  (process.env.LOG_LEVEL as LogLevel) || (isProduction ? 'info' : 'debug')
] ?? LOG_LEVELS.debug;

function serializeArg(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: isProduction ? undefined : value.stack
    });
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable-object]';
    }
  }

  return String(value);
}

function normalizeDevArg(value: unknown): unknown {
  return value instanceof Error ? serializeArg(value) : value;
}

function formatArgs(args: unknown[]): string {
  return args.map(serializeArg).join(' ');
}

function emitLog(level: LogLevel, context: string, args: unknown[]) {
  if (LOG_LEVELS[level] < minLevel) return;

  if (isProduction) {
    const entry = {
      level,
      ts: new Date().toISOString(),
      ctx: context,
      msg: formatArgs(args)
    };
    const out =
      level === 'error' ? console.error
        : level === 'warn' ? console.warn
          : console.log;
    out(JSON.stringify(entry));
  } else {
    const prefix = `[${context}]`;
    const out: ConsoleWriter =
      level === 'error' ? console.error
        : level === 'warn' ? console.warn
          : console.log;
    const devArgs = args.map(normalizeDevArg);

    try {
      out(prefix, ...devArgs);
    } catch {
      out(prefix, ...args.map(serializeArg));
    }
  }
}

export function createLogger(context: string) {
  return {
    debug: (...args: unknown[]) => emitLog('debug', context, args),
    info: (...args: unknown[]) => emitLog('info', context, args),
    warn: (...args: unknown[]) => emitLog('warn', context, args),
    error: (...args: unknown[]) => emitLog('error', context, args)
  };
}

export type Logger = ReturnType<typeof createLogger>;
