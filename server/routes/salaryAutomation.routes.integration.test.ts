import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setupTestAdminSession, TEST_ADMIN_HEADER } from '../test-utils/admin-test-session';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

vi.mock('../storage', () => ({ storage: {} }));
vi.mock('../repositories/monthlySalaryRunRepository', () => ({
  monthlySalaryRunRepository: { getRecentMonthlySalaryRuns: vi.fn(async () => []) },
}));
vi.mock('../services/monthlySalaryAutomation', () => ({
  getPreviousSalaryMonthTarget: () => ({ year: 2026, month: 9 }),
  runMonthlySalaryAutomation: vi.fn(),
}));
vi.mock('../services/salaryEmail', () => ({ sendSalaryAutomationTestEmail: vi.fn() }));
vi.mock('../middleware/requireAdmin', () => ({
  requireAdmin:
    () =>
    (req: { session?: { adminAuth?: { isAdmin?: boolean } } }, res: any, next: () => void) => {
      if (!req.session?.adminAuth?.isAdmin) {
        return res.status(401).json({ success: false });
      }
      next();
    },
}));

const ORIGINAL_ENV = { ...process.env };
// 合成假金鑰，只用來確認設定 API 不會回傳它。
const SYNTHETIC_API_KEY = 'synthetic-resend-key-for-route-tests-only';

let registerSalaryAutomationRoutes: typeof import('./salaryAutomation.routes').registerSalaryAutomationRoutes;

beforeAll(async () => {
  ({ registerSalaryAutomationRoutes } = await import('./salaryAutomation.routes'));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function getConfig(env: Record<string, string | undefined>) {
  process.env = {
    ...ORIGINAL_ENV,
    SALARY_AUTOMATION_EMAIL_TO: 'payroll@example.test',
    SMTP_HOST: undefined,
    SMTP_FROM: undefined,
    RESEND_API_KEY: undefined,
    RESEND_FROM: undefined,
    ...env,
  };
  const server = await createJsonTestServer(registerSalaryAutomationRoutes, {
    setupApp: async (app) => setupTestAdminSession(app),
  });

  try {
    return await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/salary-automation/config', {
      headers: { [TEST_ADMIN_HEADER]: 'true' },
    });
  } finally {
    await server.close();
  }
}

describe('salary automation config route', () => {
  it('reports Resend as a ready email transport without SMTP_HOST and never returns the key', async () => {
    const res = await getConfig({ RESEND_API_KEY: SYNTHETIC_API_KEY, RESEND_FROM: 'payroll@mail.example.test' });

    expect(res.response.status).toBe(200);
    expect(res.body).toMatchObject({ emailTransport: 'resend', smtpConfigured: true });
    expect(res.body?.warnings).not.toContain('SMTP_HOST is not configured.');
    expect(res.text).not.toContain(SYNTHETIC_API_KEY);
  });

  it('keeps the SMTP readiness signal unchanged when RESEND_API_KEY is not set', async () => {
    const ready = await getConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'payroll@example.test' });
    expect(ready.body).toMatchObject({ emailTransport: 'smtp', smtpConfigured: true });

    const missingHost = await getConfig({ SMTP_FROM: 'payroll@example.test', RESEND_FROM: 'payroll@mail.example.test' });
    expect(missingHost.body).toMatchObject({ emailTransport: 'smtp', smtpConfigured: false });
  });
});
