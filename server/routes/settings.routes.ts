import crypto from "crypto";
import type { Express, Response } from "express";

import { insertSettingsSchema, type InsertSettings } from "@shared/schema";
import {
  DEFAULT_ADMIN_SETTINGS,
  toAdminSettingsPayload,
  toPublicSettingsPayload,
} from "@shared/settings";

import { PermissionLevel } from "../admin-auth";
import { getDatabaseProviderInfo } from "../config/databaseUrl";
import { db } from "../db";
import { strictLimiter } from "../middleware/rateLimiter";
import { requireAdmin } from "../middleware/requireAdmin";
import { hasAdminSession } from "../session";
import { storage } from "../storage";
import { hashAdminPin, isHashedPin } from "../utils/adminPinAuth";
import { createLogger } from "../utils/logger";

import { handleRouteError } from "./route-helpers";

const log = createLogger("settings");

const DEFAULT_BOOTSTRAP_DEDUCTIONS = [
  { name: "勞保", amount: 525, description: "員工勞保自付額" },
  { name: "健保", amount: 372, description: "員工健保自付額" },
];

function setNoStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
}

function normalizeAdminPinForStorage<T extends InsertSettings>(settings: T): T {
  if (!settings.adminPin || isHashedPin(settings.adminPin)) {
    return settings;
  }

  return {
    ...settings,
    adminPin: hashAdminPin(settings.adminPin),
  };
}

async function ensureSettings() {
  let settings = await storage.getSettings();

  if (!settings) {
    const defaultPin =
      process.env.DEFAULT_ADMIN_PIN || crypto.randomBytes(3).toString("hex");

    log.warn(
      `Settings missing; bootstrapping defaults with ${
        process.env.DEFAULT_ADMIN_PIN ? "configured" : "generated"
      } admin PIN.`,
    );

    settings = await storage.createOrUpdateSettings(
      normalizeAdminPinForStorage({
        ...DEFAULT_ADMIN_SETTINGS,
        adminPin: defaultPin,
        deductions: DEFAULT_BOOTSTRAP_DEDUCTIONS,
      }),
    );
  }

  return settings;
}

export function registerSettingsRoutes(app: Express): void {
  app.get("/api/settings", async (_req, res) => {
    try {
      const settings = await ensureSettings();
      return res.json(toPublicSettingsPayload(settings));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get("/api/settings/admin", requireAdmin(), async (_req, res) => {
    try {
      setNoStore(res);
      const settings = await ensureSettings();
      return res.json(toAdminSettingsPayload(settings));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post("/api/settings", requireAdmin(), async (req, res) => {
    try {
      setNoStore(res);
      const validatedData = insertSettingsSchema.parse(req.body);
      const requestedAdminPinChange = typeof req.body?.adminPin === "string" && req.body.adminPin.trim().length > 0;

      if (requestedAdminPinChange && !hasAdminSession(req, PermissionLevel.SUPER)) {
        return res.status(403).json({
          success: false,
          message: "Updating admin credentials requires an elevated SUPER session.",
        });
      }

      const currentSettings = await storage.getSettings();
      const isDisablingBarcode =
        currentSettings?.barcodeEnabled !== false &&
        validatedData.barcodeEnabled === false;

      const settings = await storage.createOrUpdateSettings(
        normalizeAdminPinForStorage(validatedData),
      );

      let migrationResult: { migrated: number; skipped: number } | undefined;
      if (isDisablingBarcode) {
        migrationResult = await storage.encryptAllPlaintextEmployees();
        log.info(
          `掃碼槍停用，AES 遷移完成: 加密 ${migrationResult.migrated} 筆，跳過 ${migrationResult.skipped} 筆`
        );
      }

      const payload = toAdminSettingsPayload(settings);
      return res.json(migrationResult ? { ...payload, migrationResult } : payload);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get("/api/db-status", requireAdmin(PermissionLevel.ADMIN), async (_req, res) => {
    try {
      setNoStore(res);
      const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);
      let postgresConnection = false;

      try {
        await db.execute("SELECT 1");
        postgresConnection = true;
      } catch (error) {
        log.error("PostgreSQL health check failed:", error);
      }

      return res.json({
        currentStorage: databaseProvider.key === "supabase" ? "supabase_postgres" : "postgres",
        storageMode: databaseProvider.isExternal ? "external_postgres" : "local_postgres",
        databaseProvider,
        environment: {
          DATABASE_URL: "configured",
          externalDatabase: databaseProvider.isExternal,
        },
        features: {
          databaseSwitching: false,
          supabaseMigration: false,
        },
        connections: {
          postgres: postgresConnection,
          supabase: {
            isConnected: databaseProvider.key === "supabase" ? postgresConnection : false,
            disabled: databaseProvider.key !== "supabase",
          },
        },
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get("/api/supabase-config", requireAdmin(PermissionLevel.ADMIN), async (_req, res) => {
    try {
      setNoStore(res);
      const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);

      return res.json({
        mode: databaseProvider.isExternal ? "external_postgres" : "local_postgres",
        disabled: true,
        url: "",
        key: "",
        isConfigured: databaseProvider.key === "supabase",
        isActive: databaseProvider.key === "supabase",
        provider: databaseProvider,
        message: `Production runtime uses the server-side DATABASE_URL and currently points to ${databaseProvider.label}.`,
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post(
    "/api/supabase-config",
    strictLimiter,
    requireAdmin(PermissionLevel.SUPER),
    async (_req, res) => {
      try {
        setNoStore(res);
        const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);

        return res.status(409).json({
          success: false,
          message: `Runtime database switching is disabled. Update DATABASE_URL to change the active ${databaseProvider.label} connection.`,
          disabled: true,
        });
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.get("/api/supabase-connection", requireAdmin(PermissionLevel.ADMIN), async (_req, res) => {
    try {
      setNoStore(res);
      const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);
      let isConnected = false;

      try {
        await db.execute("SELECT 1");
        isConnected = true;
      } catch (error) {
        log.error("PostgreSQL connection probe failed:", error);
      }

      return res.json({
        success: true,
        isConnected,
        errorMessage: isConnected ? null : "PostgreSQL connection failed",
        isActive: databaseProvider.key === "supabase",
        mode: databaseProvider.isExternal ? "external_postgres" : "local_postgres",
        provider: databaseProvider,
        disabled: true,
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post(
    "/api/supabase-toggle",
    strictLimiter,
    requireAdmin(PermissionLevel.SUPER),
    async (_req, res) => {
      try {
        setNoStore(res);
        const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);

        return res.status(409).json({
          success: false,
          message: `${databaseProvider.label} is already controlled by the deployed DATABASE_URL. Frontend toggles are disabled in production.`,
          disabled: true,
          isActive: databaseProvider.key === "supabase",
        });
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.post(
    "/api/supabase-migrate",
    strictLimiter,
    requireAdmin(PermissionLevel.SUPER),
    async (_req, res) => {
      try {
        setNoStore(res);
        const databaseProvider = getDatabaseProviderInfo(process.env.DATABASE_URL);

        return res.status(409).json({
          success: false,
          message: `Migration entry points are disabled because the active production database is already ${databaseProvider.label}.`,
          disabled: true,
        });
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

}
