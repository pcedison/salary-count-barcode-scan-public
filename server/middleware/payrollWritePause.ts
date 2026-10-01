import type { RequestHandler } from 'express';
import { arePayrollWritesPaused, PayrollWritesPausedError } from '../config/payrollWrites';
import { requireAdmin } from './requireAdmin';

/** Protects older HTTP handlers as well as the audited correction endpoints. */
export const payrollWritePause: RequestHandler = (req, res, next) => {
  if (!arePayrollWritesPaused() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const routePath = req.path.toLowerCase().replace(/\/+$/, '');
  // Preview reads a snapshot and signs a token; it does not persist a salary,
  // attendance row or journal entry. Confirmation remains paused.
  if (req.method === 'POST' && /^\/api\/salary-records\/[1-9]\d*\/holiday-corrections\/preview$/.test(routePath)) return next();
  const payrollMutation = /^\/api\/salary-records(?:\/|$)/.test(routePath) ||
    routePath === '/api/admin/import/salary-record' ||
    routePath === '/api/salary-automation/run' ||
    /^\/api\/employees\/[^/]+\/purge$/.test(routePath);
  if (!payrollMutation) return next();
  return requireAdmin()(req, res, () => {
    const error = new PayrollWritesPausedError();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(error.status).json({ message: error.message, code: error.code });
  });
};
