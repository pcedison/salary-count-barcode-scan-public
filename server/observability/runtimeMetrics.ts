import { getEnvironmentLoadState } from '../config/loadEnv';
import { getRuntimePathSummary } from '../config/runtimePaths';

const ROLLING_WINDOW_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

type CounterState = {
  total: number;
  events: number[];
};

type LatencySample = {
  timestamp: number;
  durationMs: number;
};

type LatencyState = {
  totalCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  samples: LatencySample[];
};

type CounterSnapshot = {
  total: number;
  lastHour: number;
  last15Minutes: number;
  last5Minutes: number;
};

type LatencySnapshot = {
  totalCount: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
  lastHour: {
    count: number;
    avgMs: number;
    maxMs: number;
    minMs: number;
    latestMs: number | null;
  };
};

const counters = new Map<string, CounterState>();
const latencies = new Map<string, LatencyState>();

function roundMetric(value: number): number {
  return Number(value.toFixed(2));
}

function pruneCounterEvents(state: CounterState, now: number): void {
  state.events = state.events.filter((timestamp) => timestamp >= now - ROLLING_WINDOW_MS);
}

function pruneLatencySamples(state: LatencyState, now: number): void {
  state.samples = state.samples.filter((sample) => sample.timestamp >= now - ROLLING_WINDOW_MS);
}

function getOrCreateCounter(metricName: string): CounterState {
  const existing = counters.get(metricName);
  if (existing) {
    return existing;
  }

  const created: CounterState = {
    total: 0,
    events: []
  };
  counters.set(metricName, created);
  return created;
}

function getOrCreateLatency(metricName: string): LatencyState {
  const existing = latencies.get(metricName);
  if (existing) {
    return existing;
  }

  const created: LatencyState = {
    totalCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    minDurationMs: 0,
    samples: []
  };
  latencies.set(metricName, created);
  return created;
}

function buildCounterSnapshot(metricName: string, now = Date.now()): CounterSnapshot {
  const state = getOrCreateCounter(metricName);
  pruneCounterEvents(state, now);

  return {
    total: state.total,
    lastHour: state.events.length,
    last15Minutes: state.events.filter((timestamp) => timestamp >= now - FIFTEEN_MINUTES_MS).length,
    last5Minutes: state.events.filter((timestamp) => timestamp >= now - FIVE_MINUTES_MS).length
  };
}

function summarizeLatencies(samples: LatencySample[]): {
  count: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
  latestMs: number | null;
} {
  if (samples.length === 0) {
    return {
      count: 0,
      avgMs: 0,
      maxMs: 0,
      minMs: 0,
      latestMs: null
    };
  }

  const durations = samples.map((sample) => sample.durationMs);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);

  return {
    count: samples.length,
    avgMs: roundMetric(totalDurationMs / samples.length),
    maxMs: Math.max(...durations),
    minMs: Math.min(...durations),
    latestMs: samples[samples.length - 1]?.durationMs ?? null
  };
}

function buildLatencySnapshot(metricName: string, now = Date.now()): LatencySnapshot {
  const state = getOrCreateLatency(metricName);
  pruneLatencySamples(state, now);

  const lifetimeAvg = state.totalCount === 0 ? 0 : roundMetric(state.totalDurationMs / state.totalCount);
  const windowSummary = summarizeLatencies(state.samples);

  return {
    totalCount: state.totalCount,
    avgMs: lifetimeAvg,
    maxMs: state.maxDurationMs,
    minMs: state.totalCount === 0 ? 0 : state.minDurationMs,
    lastHour: windowSummary
  };
}

export function recordCounter(metricName: string, now = Date.now()): void {
  const state = getOrCreateCounter(metricName);
  state.total += 1;
  state.events.push(now);
  pruneCounterEvents(state, now);
}

export function recordLatency(metricName: string, durationMs: number, now = Date.now()): void {
  const normalizedDuration = Math.max(0, durationMs);
  const state = getOrCreateLatency(metricName);

  state.totalCount += 1;
  state.totalDurationMs += normalizedDuration;
  state.maxDurationMs = Math.max(state.maxDurationMs, normalizedDuration);
  state.minDurationMs =
    state.totalCount === 1 ? normalizedDuration : Math.min(state.minDurationMs, normalizedDuration);
  state.samples.push({
    timestamp: now,
    durationMs: normalizedDuration
  });

  pruneLatencySamples(state, now);
}

export function getOperationalMetricsSummary(now = Date.now()) {
  return {
    generatedAt: new Date(now).toISOString(),
    runtime: {
      env: getEnvironmentLoadState(),
      paths: getRuntimePathSummary()
    },
    auth: {
      adminLoginFailures: buildCounterSnapshot('admin.login.failure', now)
    },
    line: {
      invalidWebhookSignatures: buildCounterSnapshot('line.webhook.invalid_signature', now),
      staleWebhookEvents: buildCounterSnapshot('line.webhook.stale_event', now)
    },
    backup: {
      createFailures: buildCounterSnapshot('backup.create.failure', now),
      restoreFailures: buildCounterSnapshot('backup.restore.failure', now),
      deleteFailures: buildCounterSnapshot('backup.delete.failure', now),
      createSuccesses: buildCounterSnapshot('backup.create.success', now),
      restoreSuccesses: buildCounterSnapshot('backup.restore.success', now),
      deleteSuccesses: buildCounterSnapshot('backup.delete.success', now)
    },
    api: {
      attendanceListLatency: buildLatencySnapshot('api.attendance.list', now),
      salaryRecordListLatency: buildLatencySnapshot('api.salary-records.list', now)
    }
  };
}

export function resetOperationalMetricsForTest(): void {
  counters.clear();
  latencies.clear();
}
