import fs from "fs";
import v8 from "v8";
import type { Express } from "express";

import { db } from "../db";

const SERVER_START_TIME = Date.now();
const FALLBACK_HEAP_FAIL_PERCENT = 90;
const HEALTH_CACHE_TTL_MS = 5_000;  // cache successful health results for 5 s
const HEALTH_ERROR_CACHE_TTL_MS = 1_000;  // cache error results for only 1 s

type HealthCacheEntry = { result: object; statusCode: number; expiresAt: number };
let healthCache: HealthCacheEntry | null = null;
const CGROUP_V2_MEMORY_MAX_PATH = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_MEMORY_MAX_PATH = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
const UNBOUNDED_MEMORY_SENTINEL_BYTES = 9_000_000_000_000_000_000;

type ProbeResult = {
  status: "pass" | "fail";
  responseTimeMs?: number;
  message?: string;
};

type MemoryCheckResult = ProbeResult & {
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
  rssMb: number;
  usagePercent: number;
  source: "cgroup" | "heap_limit";
  limitMb: number;
};

function setNoStoreHeaders(res: {
  set: (field: string, value: string) => unknown;
}): void {
  res.set("Cache-Control", "no-store");
}

function getUptimeSeconds(): number {
  return Math.floor((Date.now() - SERVER_START_TIME) / 1000);
}

function readMemoryLimitBytesFromPath(path: string): number | null {
  try {
    const rawValue = fs.readFileSync(path, "utf8").trim();
    if (!rawValue || rawValue === "max") {
      return null;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= UNBOUNDED_MEMORY_SENTINEL_BYTES) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function resolveProcessMemoryLimitBytes(): number | null {
  return (
    readMemoryLimitBytesFromPath(CGROUP_V2_MEMORY_MAX_PATH) ??
    readMemoryLimitBytesFromPath(CGROUP_V1_MEMORY_MAX_PATH)
  );
}

function roundMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function buildMemoryCheck(): MemoryCheckResult {
  const memoryUsage = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const cgroupLimitBytes = resolveProcessMemoryLimitBytes();
  const limitBytes = cgroupLimitBytes ?? heapStats.heap_size_limit;
  const currentBytes = cgroupLimitBytes ? memoryUsage.rss : memoryUsage.heapUsed;
  const usagePercent = Math.round((currentBytes / limitBytes) * 100);
  const status = usagePercent >= FALLBACK_HEAP_FAIL_PERCENT ? "fail" : "pass";
  const currentLabel = cgroupLimitBytes ? "RSS" : "heap";
  const limitLabel = cgroupLimitBytes ? "container memory" : "V8 heap limit";

  return {
    status,
    message:
      status === "fail"
        ? `Memory usage critical: ${currentLabel} ${roundMb(currentBytes)}/${roundMb(limitBytes)}MB (${usagePercent}% of ${limitLabel})`
        : `Memory usage normal: ${currentLabel} ${roundMb(currentBytes)}/${roundMb(limitBytes)}MB (${usagePercent}% of ${limitLabel})`,
    heapUsedMb: roundMb(memoryUsage.heapUsed),
    heapTotalMb: roundMb(memoryUsage.heapTotal),
    heapLimitMb: roundMb(heapStats.heap_size_limit),
    rssMb: roundMb(memoryUsage.rss),
    usagePercent,
    source: cgroupLimitBytes ? "cgroup" : "heap_limit",
    limitMb: roundMb(limitBytes),
  };
}

async function runDatabaseCheck(): Promise<ProbeResult> {
  const start = Date.now();
  const isProduction = process.env.NODE_ENV === "production";

  try {
    await db.execute("SELECT 1");
    return {
      status: "pass",
      responseTimeMs: Date.now() - start,
      message: "Database connection successful",
    };
  } catch (error) {
    return {
      status: "fail",
      responseTimeMs: Date.now() - start,
      message: isProduction
        ? "Database connection failed"
        : error instanceof Error
          ? error.message
          : "Unknown database error",
    };
  }
}

/** Exposed for testing only — resets the in-memory health cache. */
export function resetHealthCacheForTest(): void {
  healthCache = null;
}

export function registerHealthRoutes(app: Express): void {
  app.get("/api/health", async (_req, res) => {
    setNoStoreHeaders(res);

    const now = Date.now();
    if (healthCache && healthCache.expiresAt > now) {
      return res.status(healthCache.statusCode).json(healthCache.result);
    }

    const database = await runDatabaseCheck();
    const memory = buildMemoryCheck();
    const isHealthy = database.status === "pass" && memory.status === "pass";
    const statusCode = isHealthy ? 200 : 503;

    const result = {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      uptimeSeconds: getUptimeSeconds(),
      version: process.env.npm_package_version || "1.0.0",
      checks: {
        database,
        memory,
      },
    };

    healthCache = {
      result,
      statusCode,
      expiresAt: now + (isHealthy ? HEALTH_CACHE_TTL_MS : HEALTH_ERROR_CACHE_TTL_MS),
    };

    return res.status(statusCode).json(result);
  });

  app.get("/ready", async (_req, res) => {
    setNoStoreHeaders(res);
    const database = await runDatabaseCheck();
    const ready = database.status === "pass";

    return res.status(ready ? 200 : 503).json({
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        database,
      },
    });
  });

  app.get("/live", (_req, res) => {
    setNoStoreHeaders(res);
    return res.json({
      alive: true,
      timestamp: new Date().toISOString(),
      uptimeSeconds: getUptimeSeconds(),
    });
  });
}
