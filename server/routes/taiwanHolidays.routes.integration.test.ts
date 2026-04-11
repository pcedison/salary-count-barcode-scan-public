import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setupTestAdminSession, TEST_ADMIN_HEADER } from "../test-utils/admin-test-session";
import { createJsonTestServer, jsonRequest } from "../test-utils/http-test-server";

// ── In-memory state ──────────────────────────────────────────────────────────

const holidaysState = vi.hoisted(() => ({
  holidays: [] as Array<Record<string, any>>,
  lastImportResult: null as null | { imported: number; replaced: number },
}));

// ── Storage mock ─────────────────────────────────────────────────────────────

const storageMock = vi.hoisted(() => ({
  getTaiwanHolidays: vi.fn(async (year?: number) => {
    if (year !== undefined) {
      return holidaysState.holidays.filter((h) => h.year === year);
    }
    return holidaysState.holidays;
  }),

  importTaiwanHolidays: vi.fn(async (incoming: Array<Record<string, any>>) => {
    const years = Array.from(new Set(incoming.map((h) => h.year)));
    let replaced = 0;
    for (const y of years) {
      const before = holidaysState.holidays.length;
      holidaysState.holidays = holidaysState.holidays.filter((h) => h.year !== y);
      replaced += before - holidaysState.holidays.length;
    }
    for (const h of incoming) {
      holidaysState.holidays.push({ id: `uuid-${Date.now()}-${Math.random()}`, ...h, createdAt: new Date() });
    }
    holidaysState.lastImportResult = { imported: incoming.length, replaced };
    return holidaysState.lastImportResult;
  }),

  deleteTaiwanHoliday: vi.fn(async (id: string) => {
    const idx = holidaysState.holidays.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    holidaysState.holidays.splice(idx, 1);
    return true;
  }),
}));

vi.mock("../storage", () => ({ storage: storageMock }));

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

let registerTaiwanHolidaysRoutes: typeof import("./taiwanHolidays.routes").registerTaiwanHolidaysRoutes;

beforeAll(async () => {
  ({ registerTaiwanHolidaysRoutes } = await import("./taiwanHolidays.routes"));
});

beforeEach(() => {
  holidaysState.holidays = [];
  holidaysState.lastImportResult = null;
  vi.clearAllMocks();
});

// ── Sample holidays ──────────────────────────────────────────────────────────

const sampleHoliday2025 = {
  year: 2025,
  holidayDate: "2025-01-01",
  holidayName: "元旦",
  isHoliday: true,
};

const sampleHoliday2026 = {
  year: 2026,
  holidayDate: "2026-01-01",
  holidayName: "元旦",
  isHoliday: true,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("taiwanHolidays routes integration", () => {
  // ── Auth guard ──────────────────────────────────────────────────────────

  it("rejects unauthenticated requests with 401", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/taiwan-holidays");
      expect(res.response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  // ── GET list ────────────────────────────────────────────────────────────

  it("returns an empty list when no holidays exist", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any[]>(server.baseUrl, "/api/taiwan-holidays", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(200);
      expect(res.response.headers.get("cache-control")).toBe("no-store");
      expect(res.body).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("returns all holidays without year filter", async () => {
    holidaysState.holidays = [
      { id: "uuid-1", ...sampleHoliday2025, createdAt: new Date() },
      { id: "uuid-2", ...sampleHoliday2026, createdAt: new Date() },
    ];

    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any[]>(server.baseUrl, "/api/taiwan-holidays", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(200);
      expect(res.body).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("filters holidays by year", async () => {
    holidaysState.holidays = [
      { id: "uuid-1", ...sampleHoliday2025, createdAt: new Date() },
      { id: "uuid-2", ...sampleHoliday2026, createdAt: new Date() },
    ];

    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any[]>(server.baseUrl, "/api/taiwan-holidays?year=2025", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body![0].year).toBe(2025);
    } finally {
      await server.close();
    }
  });

  it("returns 400 for an invalid year parameter", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/taiwan-holidays?year=abc", {
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  // ── POST /import ────────────────────────────────────────────────────────

  it("imports holidays and returns imported/replaced counts", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<{ imported: number; replaced: number }>(
        server.baseUrl,
        "/api/taiwan-holidays/import",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TEST_ADMIN_HEADER]: "true",
          },
          body: JSON.stringify({ holidays: [sampleHoliday2025] }),
        },
      );
      expect(res.response.status).toBe(200);
      expect(res.body?.imported).toBe(1);
      expect(res.body?.replaced).toBe(0);
      expect(holidaysState.holidays).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("replaces existing holidays for the same year on re-import", async () => {
    holidaysState.holidays = [
      { id: "uuid-old", ...sampleHoliday2025, createdAt: new Date() },
    ];

    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    const newHoliday = { ...sampleHoliday2025, holidayDate: "2025-02-28", holidayName: "和平紀念日" };

    try {
      const res = await jsonRequest<{ imported: number; replaced: number }>(
        server.baseUrl,
        "/api/taiwan-holidays/import",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TEST_ADMIN_HEADER]: "true",
          },
          body: JSON.stringify({ holidays: [newHoliday] }),
        },
      );
      expect(res.response.status).toBe(200);
      expect(res.body?.imported).toBe(1);
      expect(res.body?.replaced).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("returns 400 when import payload is an empty array", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/taiwan-holidays/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ holidays: [] }),
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns 400 when import payload is missing 'holidays' key", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/taiwan-holidays/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({}),
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns 400 when holiday items are missing required fields", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, "/api/taiwan-holidays/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_ADMIN_HEADER]: "true",
        },
        body: JSON.stringify({ holidays: [{ year: 2025 }] }), // missing holidayDate + holidayName
      });
      expect(res.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  // ── DELETE ──────────────────────────────────────────────────────────────

  it("deletes a holiday by UUID and returns 204", async () => {
    const testId = "11111111-1111-1111-1111-111111111111";
    holidaysState.holidays = [
      { id: testId, ...sampleHoliday2025, createdAt: new Date() },
    ];

    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(server.baseUrl, `/api/taiwan-holidays/${testId}`, {
        method: "DELETE",
        headers: { [TEST_ADMIN_HEADER]: "true" },
      });
      expect(res.response.status).toBe(204);
      expect(holidaysState.holidays).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("returns 404 when deleting a non-existent holiday", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    try {
      const res = await jsonRequest<any>(
        server.baseUrl,
        "/api/taiwan-holidays/99999999-9999-9999-9999-999999999999",
        {
          method: "DELETE",
          headers: { [TEST_ADMIN_HEADER]: "true" },
        },
      );
      expect(res.response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  // ── Full happy path ─────────────────────────────────────────────────────

  it("import → list → delete happy path", async () => {
    const server = await createJsonTestServer(registerTaiwanHolidaysRoutes, {
      setupApp: async (app) => setupTestAdminSession(app),
    });

    const headers = {
      "content-type": "application/json",
      [TEST_ADMIN_HEADER]: "true",
    };

    try {
      // Import
      const importRes = await jsonRequest<{ imported: number; replaced: number }>(
        server.baseUrl,
        "/api/taiwan-holidays/import",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ holidays: [sampleHoliday2025, sampleHoliday2026] }),
        },
      );
      expect(importRes.response.status).toBe(200);
      expect(importRes.body?.imported).toBe(2);

      // List all
      const listAll = await jsonRequest<any[]>(server.baseUrl, "/api/taiwan-holidays", { headers });
      expect(listAll.response.status).toBe(200);
      expect(listAll.body).toHaveLength(2);

      // List filtered by year
      const listFiltered = await jsonRequest<any[]>(
        server.baseUrl,
        "/api/taiwan-holidays?year=2025",
        { headers },
      );
      expect(listFiltered.body).toHaveLength(1);

      // Delete one
      const idToDelete: string = listAll.body![0].id;
      const deleteRes = await jsonRequest<any>(
        server.baseUrl,
        `/api/taiwan-holidays/${idToDelete}`,
        { method: "DELETE", headers },
      );
      expect(deleteRes.response.status).toBe(204);

      // List again
      const listFinal = await jsonRequest<any[]>(server.baseUrl, "/api/taiwan-holidays", { headers });
      expect(listFinal.body).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
