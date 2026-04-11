import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@shared/schema";
import { shouldDisablePreparedStatements } from "./config/databaseUrl";
import { createLogger } from "./utils/logger";

const log = createLogger('db');

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseUrl = process.env.DATABASE_URL;

// Determine SSL config based on the host:
//   - Local (localhost/127.0.0.1/::1): no SSL needed.
//   - External (Supabase, hosted PG): enforce SSL encryption with certificate
//     validation enabled by default (rejectUnauthorized: true).
//   - Set PGSSLREJECT_UNAUTHORIZED=false to opt out of cert validation when
//     the hosted pooler presents an untrusted certificate chain (e.g. Supabase /
//     Zeabur). A warning is emitted so the operator is aware of the trade-off.
function buildSslConfig(url: string): boolean | { rejectUnauthorized: boolean } {
  try {
    const { hostname } = new URL(url);
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1';
    if (isLocal) return false;

    const rejectUnauthorized =
      process.env.PGSSLREJECT_UNAUTHORIZED !== 'false';

    if (!rejectUnauthorized) {
      log.warn(
        'PGSSLREJECT_UNAUTHORIZED=false: SSL certificate validation is disabled. ' +
        'This is insecure — only use this setting when your hosted pooler presents ' +
        'an untrusted certificate chain that cannot be resolved another way.'
      );
    }

    return { rejectUnauthorized };
  } catch {
    return false;
  }
}

const postgresOptions = {
  ssl: buildSslConfig(databaseUrl),
  ...(shouldDisablePreparedStatements(databaseUrl) ? { prepare: false as const } : {}),
};

export const sql = postgres(databaseUrl, postgresOptions);
export const db = drizzle(sql, { schema });
