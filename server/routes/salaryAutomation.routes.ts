import type { Express } from 'express';
import { z } from 'zod';

import {
  getSalaryAutomationConfig,
  getSalaryAutomationConfigWarnings,
  getSalaryEmailTransport,
  isSalaryEmailTransportConfigured,
} from '../config/salaryAutomation';
import { requireAdmin } from '../middleware/requireAdmin';
import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';
import {
  getPreviousSalaryMonthTarget,
  runMonthlySalaryAutomation,
} from '../services/monthlySalaryAutomation';
import { SalaryEmailDeliveryError, sendSalaryAutomationTestEmail } from '../services/salaryEmail';
import { createLogger } from '../utils/logger';
import { handleRouteError } from './route-helpers';

const log = createLogger('salary-automation');

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
      emailTransport: getSalaryEmailTransport(config),
      // 欄位名稱沿用 smtpConfigured 以相容既有前端；語意是「目前的寄信通道（SMTP 或 Resend）已可用」。
      smtpConfigured: isSalaryEmailTransportConfigured(config),
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
      if (err instanceof SalaryEmailDeliveryError) {
        // 上游寄信服務失敗：訊息只含狀態碼與 Resend 錯誤說明（已遮蔽 key、不含內文），
        // production 也回給管理員以便診斷；用 502 表示是外部服務錯誤而非請求有誤。
        log.warn('Salary automation test email delivery failed', {
          code: err.code,
          providerStatus: err.providerStatus,
          message: err.message,
        });
        return res.status(502).json({ message: err.message, code: err.code });
      }
      return handleRouteError(err, res);
    }
  });
}
