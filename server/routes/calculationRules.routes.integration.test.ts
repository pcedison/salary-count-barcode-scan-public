import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setupTestAdminSession, TEST_ADMIN_HEADER } from "../test-utils/admin-test-session";
import { createJsonTestServer, jsonRequest } from "../test-utils/http-test-server";

// ── In-memory state ──────────────────────────────────────────────────────────

const rulesState = vi.hoisted(() => ({
  rules: [] as Array<Record<string, any>>,
  nextId: 1,
}));

// ── Storage mock ─────────────────────────────────────────────────────────────

const storageMock = vi.hoisted(() => ({
  getCalculationRules: vi.fn(async () => rulesState.rules),

  createCalculationRule: vi.fn(async (data: Record<string, any>) => {
    const rule = { id: rulesState.nextId++, ...data, createdAt: new Date(), updatedAt: new Date() };
    rulesState.rules.push(rule);
    return rule;
  }),

  updateCalculationRule: vi.fn(async (id: number, data: Record<string, any>) => {
    const idx = rulesState.rules.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    rulesState.rules[idx] = { ...rulesState.rules[idx], ...data, updatedAt: new Date() };
    return rulesState.rules[idx];
  }),

  deleteCalculationRule: vi.fn(async (id: number) => {
    const idx = rulesState.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rulesState.rules.splice(idx, 1);
    return true;
  }),
}));

vi.mock("../storage", () => ({ storage: storageMock }));

vi.mock("../services/calculationRulesLoader", () => ({
  reloadCalculationRulesFromDb: vi.fn(async () => 0),
}));

vi.mock("../middleware/requireAdmin", () => ({
  requireAdmin:
    () =>
    (req: { session?: { adminAuth?: { isAdmin?: boolean } } }, res: any, next: () => void) => {
      if (!req.session?.adminAuth?.isAdmin) {
        return res.status(401).json({
          success: false,
          message: "缺少管理員授權，請重新登入管理員模式",
        });
      }
      next();
    },
}));

// ── Module import ────────────────────────────────────────────────────────────

let registerCalculationRulesRoutes: typeof import("./calculationRules.routes").registerCalculationRulesRoutes;

beforeAll(async () => {
  ({ registerCalculationRulesRoutes } = await import("./calculationRules.routes"));
});

beforeEach(() => {
  rulesState.rules = [];
  rulesState.nextId = 1;
  vi.clearAllMocks();
});

// ── A valid rule payload (all required fields) ───────────────────────────────

const validRulePayload = {
  ruleKey: "2025-04-example",
  version: "2025.4.1",
  year: 2025,
  month: 4,
  employeeId: null,
  totalOT1Hours: 10,
  totalOT2Hours: 5,
  baseSalary: 30000,
  welfareAllowance: null,
  housingAllowance: null,
  totalOvertimePay: 8000,
  grossSalary: 38000,
  netSalary: 37000,
  description: "Synthetic example rule",
  createdBy: "admin",
  isActive: true,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("calculationRules routes integration", () => {
  // ── Auth guard ──────────────────────────────────────────────────────────

  it("rejects unauthenticated requests with 401", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules");
      expect(res.response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  // ── GET list ────────────────────────────────────────────────────────────

  it("returns an empty list when no rules exist", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any[]>(server.baseUrl, "/api/calculation-rules", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(200);
      expect(res.response.headers.get("cache-control")).toBe("no-store");
      expect(res.body).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("returns all rules", async () => {
    rulesState.rules = [
      { id: 1, ruleKey: "2025-01-example", version: "1", year: 2025, month: 1, createdAt: new Date(), updatedAt: new Date() },
    ];

    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any[]>(server.baseUrl, "/api/calculation-rules", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body![0].ruleKey).toBe("2025-01-example");
    } finally {
      await server.close();
    }
  });

  // ── POST create ─────────────────────────────────────────────────────────

  it("creates a rule and returns 201", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify(validRulePayload),
      });
      expect(res.response.status).toBe(201);
      expect(res.body?.ruleKey).toBe(validRulePayload.ruleKey);
      expect(res.body?.id).toBeDefined();
      expect(rulesState.rules).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("returns 400 when required fields are missing on create", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      // Missing ruleKey, year, month, etc.
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ description: "Incomplete rule" }),
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  // ── PUT update ──────────────────────────────────────────────────────────

  it("updates a rule and returns the updated record", async () => {
    rulesState.rules = [
      {
        id: 1,
        ...validRulePayload,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/1", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ description: "Updated description" }),
      });
      expect(res.response.status).toBe(200);
      expect(res.body?.description).toBe("Updated description");
    } finally {
      await server.close();
    }
  });

  it("returns 404 when updating a non-existent rule", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/999", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ description: "Ghost" }),
      });
      expect(res.response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns 400 for a non-numeric ID on PUT", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/abc", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ description: "Bad ID" }),
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  // ── DELETE ──────────────────────────────────────────────────────────────

  it("deletes a rule and returns 204", async () => {
    rulesState.rules = [
      {
        id: 1,
        ...validRulePayload,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/1", {
        method: "DELETE",
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(204);
      expect(rulesState.rules).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("returns 404 when deleting a non-existent rule", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/999", {
        method: "DELETE",
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns 400 for a non-numeric ID on DELETE", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules/abc", {
        method: "DELETE",
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  // ── Full happy path ─────────────────────────────────────────────────────

  it("create → list → update → delete happy path", async () => {
    const server = await createJsonTestServer(registerCalculationRulesRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    const headers = {
      "content-type": "application/json",
      [TEST_ADMIN_HEADER]: "true",
    };

    try {
      // Create
      const created = await jsonRequest<any>(server.baseUrl, "/api/calculation-rules", {
        method: "POST",
        headers,
        body: JSON.stringify(validRulePayload),
      });
      expect(created.response.status).toBe(201);
      const id: number = created.body!.id;

      // List
      const list = await jsonRequest<any[]>(server.baseUrl, "/api/calculation-rules", {
        headers,
      });
      expect(list.response.status).toBe(200);
      expect(list.body).toHaveLength(1);

      // Update
      const updated = await jsonRequest<any>(server.baseUrl, `/api/calculation-rules/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "Updated" }),
      });
      expect(updated.response.status).toBe(200);
      expect(updated.body?.description).toBe("Updated");

      // Delete
      const deleted = await jsonRequest<any>(server.baseUrl, `/api/calculation-rules/${id}`, {
        method: "DELETE",
        headers,
      });
      expect(deleted.response.status).toBe(204);

      // List again — should be empty
      const listAfter = await jsonRequest<any[]>(server.baseUrl, "/api/calculation-rules", {
        headers,
      });
      expect(listAfter.body).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
