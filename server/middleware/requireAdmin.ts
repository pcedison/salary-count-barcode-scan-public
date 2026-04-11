import type { NextFunction, Request, Response } from 'express';

import {
  PermissionLevel,
  logOperation,
  OperationType
} from '../admin-auth';
import { hasAdminSession, touchAdminSession } from '../session';

export async function hasAdminAuthorization(
  req: {
    session?: Request['session'];
  },
  requiredLevel: PermissionLevel = PermissionLevel.ADMIN
): Promise<boolean> {
  if (hasAdminSession(req, requiredLevel)) {
    touchAdminSession(req);
    return true;
  }

  return false;
}

export function requireAdmin(requiredLevel: PermissionLevel = PermissionLevel.ADMIN) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await hasAdminAuthorization(req, requiredLevel)) {
      next();
      return;
    }

    const hasAnyAdminSession = hasAdminSession(req, PermissionLevel.BASIC);

    if (!hasAnyAdminSession) {
      logOperation(
        OperationType.AUTHORIZATION,
        `缺少管理員授權: ${req.method} ${req.originalUrl}`,
        {
          ip: req.ip,
          success: false,
          errorMessage: 'missing_admin_pin'
        }
      );

      res.setHeader('x-admin-session-required', 'true');
      return res.status(401).json({
        success: false,
        message: '缺少管理員授權，請重新登入管理員模式'
      });
    }

    logOperation(
      OperationType.AUTHORIZATION,
      `管理員授權失敗: ${req.method} ${req.originalUrl}`,
      {
        ip: req.ip,
        success: false,
        errorMessage: 'invalid_admin_pin'
      }
    );

    return res.status(403).json({
      success: false,
      message: '管理員授權失敗'
    });
  };
}
