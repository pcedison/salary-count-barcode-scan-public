import type { RequestHandler } from 'express';
import { arePayrollWritesPaused, PayrollWritesPausedError } from '../config/payrollWrites';
import { requireAdmin } from './requireAdmin';
import { PermissionLevel } from '../admin-auth';

export const payrollWritePause: RequestHandler = (req, res, next) => {
  if (!arePayrollWritesPaused() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const routePath = req.path.toLowerCase().replace(/\/+$/, '');
  const payrollMutation = /^\/api\/salary-records(?:\/|$)/.test(routePath) ||
    routePath === '/api/admin/import/salary-record' ||
    routePath === '/api/salary-automation/run' ||
    /^\/api\/employees\/[^/]+\/purge$/.test(routePath);
  const backupMutation = /^\/api\/dashboard\/backups(?:\/|$)/.test(routePath);
  if (!payrollMutation && !backupMutation) return next();
  const requiresSuper = backupMutation || /^\/api\/employees\/[^/]+\/purge$/.test(routePath);
  return requireAdmin(requiresSuper ? PermissionLevel.SUPER : PermissionLevel.ADMIN)(req, res, () => {
    const error = new PayrollWritesPausedError();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(error.status).json({
      message: backupMutation ? '維護版本停用 JSON 備份寫入與還原；請使用經確認的完整 PostgreSQL 備份。' : error.message,
      code: backupMutation ? 'MAINTENANCE_BACKUP_READ_ONLY' : error.code,
    });
  });
};
