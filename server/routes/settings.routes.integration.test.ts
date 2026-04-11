import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setupTestAdminSession, TEST_ADMIN_HEADER } from "../test-utils/admin-test-session";
import { createJsonTestServer, jsonRequest } from "../test-utils/http-test-server";

const settingsState = vi.hoisted(() => ({
  settings: null as null | Record<string, any>,
  savedSettings: null as null | Record<string, any>,
}));

const storageMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => settingsState.settings),
  createOrUpdateSettings: vi.fn(async (payload: Record<string, any>) => {
    settingsState.savedSettings = payload;
    settingsState.settings = {
      id: 1,
      updatedAt: new Date("2026-03-12T00:00:00.000Z"),
      ...payload,
    };
    return settingsState.settings;
  }),
}));

vi.mock("../storage", () => ({
  storage: storageMock,
}));

vi.mock("../db", () => ({
  db: {
    execute: vi.fn(async () => [{ "?column?": 1 }]),
  },
}));

vi.mock("../middleware/rateLimiter", () => ({
  strictLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/requireAdmin", () => ({
  requireAdmin:
    () =>
    (
      req: { session?: { adminAuth?: { isAdmin?: boolean } } },
      res: any,
      next: () => void,
    ) => {
      if (!req.session?.adminAuth?.isAdmin) {
        return res.status(401).json({
          success: false,
          message: "缺少管理員授權，請重新登入管理員模式",
        });
      }

      next();
    },
}));

let registerSettingsRoutes: typeof import("./settings.routes").registerSettingsRoutes;
let originalDatabaseUrl: string | undefined;

beforeAll(async () => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  ({ registerSettingsRoutes } = await import("./settings.routes"));
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }

  process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(() => {
  delete process.env.DATABASE_URL;
  settingsState.settings = null;
  settingsState.savedSettings = null;
  vi.clearAllMocks();
});

describe("settings routes integration", () => {
  it("creates default settings on first public read and only exposes public fields", async () => {
    const server = await createJsonTestServer(registerSettingsRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      },
    });

    try {
      const result = await jsonRequest<Record<string, any>>(server.baseUrl, "/api/settings");

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({
        baseHourlyRate: 119,
        ot1Multiplier: 1.34,
        ot2Multiplier: 1.67,
        baseMonthSalary: 28590,
        welfareAllowance: 0,
        barcodeEnabled: true,
      });
      expect(settingsState.savedSettings).toMatchObject({
        baseHourlyRate: 119,
        baseMonthSalary: 28590,
      });
      expect(settingsState.savedSettings?.deductions).toHaveLength(2);
      expect(settingsState.savedSettings?.adminPin).toContain(":");
    } finally {
      await server.close();
    }
  });

  it("requires admin authorization for full settings and strips adminPin from the response", async () => {
    settingsState.settings = {
      id: 1,
      baseHourlyRate: 119,
      ot1Multiplier: 1.34,
      ot2Multiplier: 1.67,
      baseMonthSalary: 28590,
      welfareAllowance: 500,
      deductions: [{ name: "勞保", amount: 525, description: "員工勞保自付額" }],
      allowances: [{ name: "福利金", amount: 500, description: "員工福利津貼" }],
      adminPin: "123456",
      updatedAt: new Date("2026-03-12T00:00:00.000Z"),
    };

    const server = await createJsonTestServer(registerSettingsRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      },
    });

    try {
      const unauthorized = await jsonRequest<Record<string, any>>(server.baseUrl, "/api/settings/admin");
      expect(unauthorized.response.status).toBe(401);

      const authorized = await jsonRequest<Record<string, any>>(server.baseUrl, "/api/settings/admin", {
        headers: {
          [TEST_ADMIN_HEADER]: "true",
        },
      });

      expect(authorized.response.status).toBe(200);
      expect(authorized.response.headers.get("cache-control")).toBe("no-store");
      expect(authorized.body).toMatchObject({
        baseHourlyRate: 119,
        baseMonthSalary: 28590,
        welfareAllowance: 500,
        deductions: [{ name: "勞保", amount: 525, description: "員工勞保自付額" }],
        allowances: [{ name: "福利金", amount: 500, description: "員工福利津貼" }],
      });
      expect(authorized.body?.adminPin).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("updates settings through the protected route and keeps the stored admin pin hashed", async () => {
    settingsState.settings = {
      id: 1,
      baseHourlyRate: 119,
      ot1Multiplier: 1.34,
      ot2Multiplier: 1.67,
      baseMonthSalary: 28590,
      welfareAllowance: 0,
      deductions: [],
      allowances: [],
      adminPin: "123456",
      updatedAt: new Date("2026-03-12T00:00:00.000Z"),
    };

    const server = await createJsonTestServer(registerSettingsRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      },
    });

    try {
      const result = await jsonRequest<Record<string, any>>(server.baseUrl, "/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({
          baseHourlyRate: 125,
          ot1Multiplier: 1.34,
          ot2Multiplier: 1.67,
          baseMonthSalary: 30000,
          welfareAllowance: 500,
          adminPin: "654321",
          deductions: [],
          allowances: [{ name: "福利金", amount: 500, description: "員工福利津貼" }],
        }),
      });

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(settingsState.savedSettings).toMatchObject({
        baseHourlyRate: 125,
        baseMonthSalary: 30000,
        welfareAllowance: 500,
      });
      expect(settingsState.savedSettings?.adminPin).toContain(":");
      expect(result.body).toMatchObject({
        baseHourlyRate: 125,
        baseMonthSalary: 30000,
        welfareAllowance: 500,
        allowances: [{ name: "福利金", amount: 500, description: "員工福利津貼" }],
      });
      expect(result.body?.adminPin).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("requires admin authorization for infrastructure status endpoints", async () => {
    const server = await createJsonTestServer(registerSettingsRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      },
    });

    try {
      const unauthorizedDbStatus = await jsonRequest<{ success: boolean; message: string }>(
        server.baseUrl,
        "/api/db-status",
      );
      expect(unauthorizedDbStatus.response.status).toBe(401);

      const unauthorizedSupabaseConfig = await jsonRequest<{ success: boolean; message: string }>(
        server.baseUrl,
        "/api/supabase-config",
      );
      expect(unauthorizedSupabaseConfig.response.status).toBe(401);

      const unauthorizedSupabaseConnection = await jsonRequest<{ success: boolean; message: string }>(
        server.baseUrl,
        "/api/supabase-connection",
      );
      expect(unauthorizedSupabaseConnection.response.status).toBe(401);

      const headers = {
        [TEST_ADMIN_HEADER]: "true",
      };

      const dbStatus = await jsonRequest<Record<string, any>>(server.baseUrl, "/api/db-status", {
        headers,
      });
      expect(dbStatus.response.status).toBe(200);
      expect(dbStatus.response.headers.get("cache-control")).toBe("no-store");
      expect(dbStatus.body).toMatchObject({
        currentStorage: "postgres",
        storageMode: "local_postgres",
        features: {
          databaseSwitching: false,
          supabaseMigration: false,
        },
        environment: {
          DATABASE_URL: "configured",
          externalDatabase: false,
        },
        connections: {
          postgres: true,
        },
      });

      const supabaseConfig = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        "/api/supabase-config",
        {
          headers,
        },
      );
      expect(supabaseConfig.response.status).toBe(200);
      expect(supabaseConfig.response.headers.get("cache-control")).toBe("no-store");
      expect(supabaseConfig.body).toMatchObject({
        mode: "local_postgres",
        disabled: true,
        isConfigured: false,
      });

      const supabaseConnection = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        "/api/supabase-connection",
        {
          headers,
        },
      );
      expect(supabaseConnection.response.status).toBe(200);
      expect(supabaseConnection.response.headers.get("cache-control")).toBe("no-store");
      expect(supabaseConnection.body).toMatchObject({
        success: true,
        isConnected: true,
        disabled: true,
        mode: "local_postgres",
      });
    } finally {
      await server.close();
    }
  });
});
