import type { Express, Request } from 'express';

import { PermissionLevel } from '../admin-auth';
import { setupAdminSession } from '../session';

export const TEST_ADMIN_HEADER = 'x-test-admin';
export const TEST_SCAN_UNLOCK_HEADER = 'x-test-scan-unlocked';

export function setupTestAdminSession(app: Express): void {
  setupAdminSession(app);

  app.use((req, _res, next) => {
    if (req.headers[TEST_ADMIN_HEADER] === 'true') {
      req.session.adminAuth = {
        isAdmin: true,
        permissionLevel: PermissionLevel.SUPER,
        authenticatedAt: Date.now(),
        lastVerifiedAt: Date.now()
      };
    }

    if (req.headers[TEST_SCAN_UNLOCK_HEADER] === 'true') {
      req.session.scanAccess = {
        unlockedAt: Date.now(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000
      };
    }

    next();
  });
}

export function hasTestAdminSession(req: Pick<Request, 'session'>): boolean {
  return Boolean(req.session?.adminAuth?.isAdmin);
}
