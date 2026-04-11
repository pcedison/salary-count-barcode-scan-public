import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt as encryptAes } from '@shared/utils/encryption';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';

const employeeFixture = vi.hoisted(() => ({
  id: 5,
  name: 'Alice Example',
  department: 'Operations',
  idNumber: 'A123456789',
  specialLeaveDate: '2026-03-12',
  specialLeaveDateSlash: '2026/03/12'
}));

const employeeState = vi.hoisted(() => ({
  employee: {
    id: employeeFixture.id,
    name: employeeFixture.name,
    idNumber: employeeFixture.idNumber,
    isEncrypted: false,
    employeeType: 'local' as const,
    position: null as string | null,
    department: employeeFixture.department,
    email: null as string | null,
    phone: null as string | null,
    active: true,
    specialLeaveDays: 0,
    specialLeaveWorkDateRange: null as string | null,
    specialLeaveUsedDates: [] as string[],
    specialLeaveCashDays: 0,
    specialLeaveCashMonth: null as string | null,
    specialLeaveNotes: null as string | null,
    deletedAt: null as Date | null,
    deletedBy: null as string | null,
    purgeAfterAt: null as Date | null,
    createdAt: new Date('2026-03-01T00:00:00.000Z')
  },
  holidays: [] as Array<Record<string, any>>,
  temporaryAttendance: [] as Array<Record<string, any>>,
  createdHolidays: [] as Array<Record<string, any>>,
  createdAttendance: [] as Array<Record<string, any>>,
  deletedHolidayIds: [] as number[],
  deletedAttendanceHolidayIds: [] as number[],
  nextHolidayId: 1
}));

const storageMock = vi.hoisted(() => ({
  getAllEmployees: vi.fn(async () => (employeeState.employee.deletedAt ? [] : [employeeState.employee])),
  getDeletedEmployees: vi.fn(async () => (employeeState.employee.deletedAt ? [employeeState.employee] : [])),
  getEmployeeById: vi.fn(async (id: number) =>
    id === employeeState.employee.id && !employeeState.employee.deletedAt ? employeeState.employee : undefined
  ),
  getSettings: vi.fn(async () => null),
  updateEmployee: vi.fn(async (id: number, payload: Record<string, unknown>) => {
    if (id !== employeeState.employee.id) {
      return undefined;
    }

    employeeState.employee = {
      ...employeeState.employee,
      ...payload
    };

    return employeeState.employee;
  }),
  deleteEmployee: vi.fn(async (id: number) => {
    if (id !== employeeState.employee.id || employeeState.employee.deletedAt) {
      return false;
    }

    employeeState.employee = {
      ...employeeState.employee,
      deletedAt: new Date('2026-04-08T00:00:00.000Z'),
      deletedBy: 'admin',
      purgeAfterAt: new Date('2026-05-08T00:00:00.000Z')
    };

    return true;
  }),
  restoreEmployee: vi.fn(async (id: number) => {
    if (id !== employeeState.employee.id || !employeeState.employee.deletedAt) {
      return undefined;
    }

    employeeState.employee = {
      ...employeeState.employee,
      deletedAt: null,
      deletedBy: null,
      purgeAfterAt: null
    };

    return employeeState.employee;
  }),
  getAllHolidays: vi.fn(async () => employeeState.holidays),
  createHoliday: vi.fn(async (payload: Record<string, any>) => {
    const holiday = {
      id: employeeState.nextHolidayId,
      description: null,
      createdAt: new Date('2026-03-12T00:00:00.000Z'),
      ...payload
    };

    employeeState.nextHolidayId += 1;
    employeeState.createdHolidays.push(holiday);
    employeeState.holidays.push(holiday);
    return holiday;
  }),
  getTemporaryAttendanceByEmployeeAndDate: vi.fn(async (employeeId: number, date: string) =>
    employeeState.temporaryAttendance.filter(
      (record) => record.employeeId === employeeId && record.date === date
    )
  ),
  createTemporaryAttendance: vi.fn(async (payload: Record<string, any>) => {
    const attendance = {
      id: employeeState.createdAttendance.length + 1,
      createdAt: new Date('2026-03-12T00:00:00.000Z'),
      ...payload
    };

    employeeState.createdAttendance.push(attendance);
    employeeState.temporaryAttendance.push(attendance);
    return attendance;
  }),
  deleteTemporaryAttendanceByHolidayId: vi.fn(async (holidayId: number) => {
    employeeState.deletedAttendanceHolidayIds.push(holidayId);
    employeeState.temporaryAttendance = employeeState.temporaryAttendance.filter(
      (record) => record.holidayId !== holidayId
    );
    return true;
  }),
  deleteHoliday: vi.fn(async (holidayId: number) => {
    employeeState.deletedHolidayIds.push(holidayId);
    employeeState.holidays = employeeState.holidays.filter((holiday) => holiday.id !== holidayId);
    return true;
  })
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('../middleware/requireAdmin', () => ({
  requireAdmin:
    () =>
    (
      req: { session?: { adminAuth?: { isAdmin?: boolean } } },
      res: { status: (code: number) => { json: (payload: unknown) => unknown } },
      next: () => void
    ) => {
      if (!req.session?.adminAuth?.isAdmin) {
        return res.status(401).json({
          success: false,
          message: 'Admin authorization required.'
        });
      }

      next();
    }
}));

let registerEmployeeRoutes: typeof import('./employees.routes').registerEmployeeRoutes;

function resetEmployeeState() {
  employeeState.employee = {
    id: employeeFixture.id,
    name: employeeFixture.name,
    idNumber: employeeFixture.idNumber,
    isEncrypted: false,
    employeeType: 'local',
    position: null,
    department: employeeFixture.department,
    email: null,
    phone: null,
    active: true,
    specialLeaveDays: 0,
    specialLeaveWorkDateRange: null,
    specialLeaveUsedDates: [],
    specialLeaveCashDays: 0,
    specialLeaveCashMonth: null,
    specialLeaveNotes: null,
    deletedAt: null,
    deletedBy: null,
    purgeAfterAt: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z')
  };
  employeeState.holidays = [];
  employeeState.temporaryAttendance = [];
  employeeState.createdHolidays = [];
  employeeState.createdAttendance = [];
  employeeState.deletedHolidayIds = [];
  employeeState.deletedAttendanceHolidayIds = [];
  employeeState.nextHolidayId = 1;
}

beforeAll(async () => {
  ({ registerEmployeeRoutes } = await import('./employees.routes'));
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.USE_AES_ENCRYPTION;
});

beforeEach(() => {
  resetEmployeeState();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('employee routes integration', () => {
  it('requires admin authorization for the operational employee list endpoint', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const publicResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/employees'
      );
      expect(publicResult.response.status).toBe(401);

      const adminResult = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(adminResult.response.status).toBe(200);
      expect(adminResult.body).toEqual([
        expect.objectContaining({
          id: employeeFixture.id,
          name: employeeFixture.name,
          department: employeeFixture.department,
          position: null,
          active: true
        })
      ]);
      expect(adminResult.body?.[0]).not.toHaveProperty('idNumber');
      expect(adminResult.body?.[0]).not.toHaveProperty('specialLeaveUsedDates');
    } finally {
      await server.close();
    }
  });

  it('requires admin authorization for the full employee list endpoint', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const unauthorized = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/employees/admin'
      );
      expect(unauthorized.response.status).toBe(401);

      const authorized = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(authorized.response.status).toBe(200);
      expect(authorized.body).toEqual([
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: employeeFixture.idNumber,
          scanIdNumber: employeeFixture.idNumber,
          department: employeeFixture.department
        })
      ]);
    } finally {
      await server.close();
    }
  });

  it('returns display ids and scan ids for AES-encrypted employees in admin flows', async () => {
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
    employeeState.employee = {
      ...employeeState.employee,
      idNumber: encryptAes(employeeFixture.idNumber),
      isEncrypted: true
    };

    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const adminList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(adminList.response.status).toBe(200);
      expect(adminList.body).toEqual([
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: employeeFixture.idNumber,
          scanIdNumber: employeeFixture.idNumber,
          isEncrypted: true
        })
      ]);

      const single = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(single.response.status).toBe(200);
      expect(single.body).toEqual(
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: employeeFixture.idNumber,
          scanIdNumber: employeeFixture.idNumber,
          isEncrypted: true
        })
      );
    } finally {
      await server.close();
    }
  });

  it('rejects unauthenticated single-employee reads and returns full profile for admin sessions', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const publicResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`
      );
      expect(publicResult.response.status).toBe(401);

      const adminResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(adminResult.response.status).toBe(200);
      expect(adminResult.body).toEqual(
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: employeeFixture.idNumber,
          scanIdNumber: employeeFixture.idNumber,
          isEncrypted: false
        })
      );
    } finally {
      await server.close();
    }
  });

  it('updates employeeType through PUT for admin employee edits', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            name: employeeState.employee.name,
            idNumber: employeeState.employee.idNumber,
            employeeType: 'foreign',
            department: employeeState.employee.department,
            active: employeeState.employee.active
          })
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual(
        expect.objectContaining({
          id: employeeFixture.id,
          employeeType: 'foreign',
          idNumber: employeeFixture.idNumber
        })
      );
      expect(employeeState.employee.employeeType).toBe('foreign');
    } finally {
      await server.close();
    }
  });

  it('updates identity fields through PATCH without silently dropping employeeType', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            idNumber: 'E01839502',
            employeeType: 'foreign'
          })
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual(
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: 'E01839502',
          employeeType: 'foreign'
        })
      );
      expect(employeeState.employee.idNumber).toBe('E01839502');
      expect(employeeState.employee.employeeType).toBe('foreign');
    } finally {
      await server.close();
    }
  });

  it('rejects invalid employeeType values instead of accepting arbitrary text', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            name: employeeState.employee.name,
            idNumber: employeeState.employee.idNumber,
            employeeType: 'foo',
            department: employeeState.employee.department,
            active: employeeState.employee.active
          })
        }
      );

      expect(result.response.status).toBe(400);
      expect(storageMock.updateEmployee).not.toHaveBeenCalled();
      expect(employeeState.employee.employeeType).toBe('local');
    } finally {
      await server.close();
    }
  });

  it('adds special leave holidays and placeholder attendance when specialLeaveUsedDates grow', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{ specialLeaveUsedDates: string[] }>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            specialLeaveUsedDates: [employeeFixture.specialLeaveDate]
          })
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body?.specialLeaveUsedDates).toEqual([employeeFixture.specialLeaveDate]);
      expect(employeeState.createdHolidays).toEqual([
        expect.objectContaining({
          employeeId: employeeFixture.id,
          date: employeeFixture.specialLeaveDateSlash,
          holidayType: 'special_leave'
        })
      ]);
      expect(employeeState.createdAttendance).toEqual([
        expect.objectContaining({
          employeeId: employeeFixture.id,
          date: employeeFixture.specialLeaveDateSlash,
          clockIn: '--:--',
          clockOut: '--:--',
          holidayType: 'special_leave'
        })
      ]);
    } finally {
      await server.close();
    }
  });

  it('removes linked holiday attendance when specialLeaveUsedDates shrink', async () => {
    employeeState.employee.specialLeaveUsedDates = [employeeFixture.specialLeaveDateSlash];
    employeeState.holidays = [
      {
        id: 9,
        employeeId: employeeFixture.id,
        date: employeeFixture.specialLeaveDateSlash,
        name: 'special leave',
        holidayType: 'special_leave',
        description: null,
        createdAt: new Date('2026-03-12T00:00:00.000Z')
      }
    ];
    employeeState.temporaryAttendance = [
      {
        id: 1,
        employeeId: employeeFixture.id,
        date: employeeFixture.specialLeaveDateSlash,
        clockIn: '--:--',
        clockOut: '--:--',
        isHoliday: true,
        isBarcodeScanned: false,
        holidayId: 9,
        holidayType: 'special_leave',
        createdAt: new Date('2026-03-12T00:00:00.000Z')
      }
    ];

    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{ specialLeaveUsedDates: string[] }>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            specialLeaveUsedDates: []
          })
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body?.specialLeaveUsedDates).toEqual([]);
      expect(employeeState.deletedAttendanceHolidayIds).toEqual([9]);
      expect(employeeState.deletedHolidayIds).toEqual([9]);
    } finally {
      await server.close();
    }
  });

  it('soft deletes employees and exposes them through the deleted employees endpoint', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const deleteResult = await jsonRequest(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}`,
        {
          method: 'DELETE',
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(deleteResult.response.status).toBe(204);
      expect(employeeState.employee.deletedAt).not.toBeNull();
      expect(employeeState.employee.deletedBy).toBe('admin');
      expect(employeeState.employee.purgeAfterAt).not.toBeNull();

      const activeList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );
      expect(activeList.response.status).toBe(200);
      expect(activeList.body).toEqual([]);

      const deletedList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/deleted',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );
      expect(deletedList.response.status).toBe(200);
      expect(deletedList.body).toEqual([
        expect.objectContaining({
          id: employeeFixture.id,
          name: employeeFixture.name,
          deletedBy: 'admin',
          salaryRetentionMode: 'anonymized',
          lineRestoreMode: 'rebind_required'
        })
      ]);
    } finally {
      await server.close();
    }
  });

  it('restores deleted employees back into the active admin list and marks them for LINE rebind', async () => {
    employeeState.employee.deletedAt = new Date('2026-04-08T00:00:00.000Z');
    employeeState.employee.deletedBy = 'admin';
    employeeState.employee.purgeAfterAt = new Date('2026-05-08T00:00:00.000Z');

    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const restoreResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        `/api/employees/${employeeFixture.id}/restore`,
        {
          method: 'POST',
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(restoreResult.response.status).toBe(200);
      expect(restoreResult.body).toEqual(
        expect.objectContaining({
          id: employeeFixture.id,
          idNumber: employeeFixture.idNumber,
          deletedAt: null,
          purgeAfterAt: null,
          requiresLineRebind: true,
          lineRestoreMode: 'rebind_required'
        })
      );

      const activeList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );
      expect(activeList.response.status).toBe(200);
      expect(activeList.body).toEqual([
        expect.objectContaining({
          id: employeeFixture.id,
          name: employeeFixture.name
        })
      ]);
    } finally {
      await server.close();
    }
  });
});
