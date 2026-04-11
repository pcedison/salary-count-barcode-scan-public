import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logOperationMock } = vi.hoisted(() => ({
  logOperationMock: vi.fn()
}));

vi.mock('../admin-auth', () => ({
  PermissionLevel: {
    BASIC: 1,
    ADMIN: 3,
    SUPER: 4
  },
  OperationType: {
    AUTHORIZATION: 'authorization'
  },
  logOperation: logOperationMock
}));

import { requireAdmin } from './requireAdmin';

function createMockResponse() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Response;
}

describe('requireAdmin middleware', () => {
  beforeEach(() => {
    logOperationMock.mockReset();
  });

  it('allows requests with an authenticated admin session', async () => {
    const req = {
      headers: {},
      session: {
        adminAuth: {
          isAdmin: true,
          permissionLevel: 4,
          authenticatedAt: Date.now(),
          lastVerifiedAt: Date.now()
        }
      },
      method: 'GET',
      originalUrl: '/api/salary-records',
      ip: '127.0.0.1'
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireAdmin()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects requests without admin authorization', async () => {
    const req = {
      headers: {},
      method: 'POST',
      originalUrl: '/api/settings',
      ip: '127.0.0.1'
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireAdmin()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('x-admin-session-required', 'true');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false
      })
    );
    expect(next).not.toHaveBeenCalled();
    expect(logOperationMock).toHaveBeenCalled();
  });


  it('rejects ADMIN sessions when SUPER permission is required', async () => {
    const req = {
      headers: {},
      session: {
        adminAuth: {
          isAdmin: true,
          permissionLevel: 3,
          authenticatedAt: Date.now(),
          lastVerifiedAt: Date.now()
        }
      },
      method: 'POST',
      originalUrl: '/api/settings/system',
      ip: '127.0.0.1'
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireAdmin(4)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false
      })
    );
    expect(next).not.toHaveBeenCalled();
    expect(logOperationMock).toHaveBeenCalled();
  });
  it('rejects requests with insufficient admin permission level', async () => {
    const req = {
      headers: {},
      session: {
        adminAuth: {
          isAdmin: true,
          permissionLevel: 1,
          authenticatedAt: Date.now(),
          lastVerifiedAt: Date.now()
        }
      },
      method: 'DELETE',
      originalUrl: '/api/employees/1',
      ip: '127.0.0.1'
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireAdmin()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false
      })
    );
    expect(next).not.toHaveBeenCalled();
    expect(logOperationMock).toHaveBeenCalled();
  });
});
