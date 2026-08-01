import type { Express } from 'express';
import { z } from 'zod';

import { getSalaryAutomationConfig, getSalaryAutomationConfigWarnings } from '../config/salaryAutomation';
import { requireAdmin } from '../middleware/requireAdmin';
import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';
import {
  getPreviousSalaryMonthTarget,
  runMonthlySalaryAutomation,
} from '../services/monthlySalaryAutomation';
import { sendSalaryAutomationTestEmail } from '../services/salaryEmail';
import { handleRouteError } from './route-helpers';

const runRequestSchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
  sendEmail: z.boolean().optional(),
});

const testEmailRequestSchema = z.object({
  to: z.string().trim().optional(),
});

export function registerSalaryAutomationRoutes(app: Express): void {
  app.get('/api/salary-automation/config', requireAdmin(), (_req, res) => {
    const config = getSalaryAutomationConfig();

    return res.json({
      enabled: config.enabled,
      timeZone: config.timeZone,
      previousTarget: getPreviousSalaryMonthTarget(new Date(), config.timeZone),
      runHour: config.runHour,
      runMinute: config.runMinute,
      intervalMs: config.intervalMs,
      emailRecipients: config.emailRecipients,
      smtpConfigured: Boolean(config.smtpHost && config.smtpFrom),
      publicBaseUrl: config.publicBaseUrl,
      chromiumConfigured: Boolean(config.chromiumExecutablePath),
      warnings: getSalaryAutomationConfigWarnings(config),
    });
  });

  app.get('/api/salary-automation/runs', requireAdmin(), async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '12'), 10) || 12));
      const runs = await monthlySalaryRunRepository.getRecentMonthlySalaryRuns(limit);
      return res.json(runs);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/salary-automation/run', requireAdmin(), async (req, res) => {
    try {
      const body = runRequestSchema.parse(req.body ?? {});
      const result = await runMonthlySalaryAutomation({
        target:
          body.year && body.month
            ? {
                year: body.year,
                month: body.month,
              }
            : undefined,
        dryRun: body.dryRun ?? false,
        force: body.force ?? false,
        sendEmail: body.dryRun ? false : body.sendEmail,
      });

      if (result.status === 'failed') {
        return res.status(500).json({
          status: 'failed',
          code: 'salary_automation_failed',
          message: 'Salary automation did not complete. Check the run history before retrying.',
          target: result.target,
        });
      }

      return res.json(result);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/salary-automation/test-email', requireAdmin(), async (req, res) => {
    try {
      const body = testEmailRequestSchema.parse(req.body ?? {});
      const result = await sendSalaryAutomationTestEmail({ to: body.to });
      return res.json({
        success: true,
        recipients: result.recipients,
        messageId: result.messageId,
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
