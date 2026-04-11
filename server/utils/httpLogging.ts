import type { LogLevel } from './logger';

const MAX_MESSAGE_LENGTH = 120;

function truncate(value: string, maxLength = MAX_MESSAGE_LENGTH) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function summarizeApiResponseBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const record = body as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  if (typeof record.message === 'string' && record.message.trim()) {
    summary.message = truncate(record.message.trim());
  }

  if (typeof record.success === 'boolean') {
    summary.success = record.success;
  }

  if (typeof record.code === 'string' && record.code.trim()) {
    summary.code = record.code.trim();
  }

  if (Array.isArray(record.errors)) {
    summary.errorCount = record.errors.length;
  }

  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : null;
}

export function getApiRequestLogLevel(statusCode: number): LogLevel {
  if (statusCode >= 500) {
    return 'error';
  }

  if (statusCode >= 400) {
    return 'warn';
  }

  return 'debug';
}

export function buildApiRequestLog(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  responseBody?: unknown
) {
  const base = `${method} ${path} ${statusCode} in ${durationMs}ms`;
  const summary = statusCode >= 400 ? summarizeApiResponseBody(responseBody) : null;

  return summary ? `${base} :: ${summary}` : base;
}
