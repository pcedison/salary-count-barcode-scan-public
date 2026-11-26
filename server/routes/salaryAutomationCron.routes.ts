import type { Express } from 'express';

import { runScheduledMonthlySalaryAutomation } from '../runtime/monthly-salary-scheduler';
import { getSalaryAutomationCronSecret, isValidCronAuthorization } from '../utils/cronAuth';
import { createLogger } from '../utils/logger';

const log = createLogger('salary-automation-cron');

/**
 * 給 Cloud Run 這類「沒請求就不給 CPU」的平台用：由外部排程（Cloud Scheduler）定時呼叫，
 * 在這個請求裡把月結跑完再回應。是否該跑、是否已跑過，仍由原本的時間判斷與
 * monthlySalaryRunRepository.acquireRun 決定，重複呼叫不會重複產生月結。
 * 未設定 SALARY_AUTOMATION_CRON_SECRET 時端點一律回 401。
 */
export function registerSalaryAutomationCronRoutes(app: Express): void {
  app.post('/api/salary-automation/cron-tick', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (!isValidCronAuthorization(req.get('Authorization'), getSalaryAutomationCronSecret())) {
      return res.status(401).json({ code: 'cron_unauthorized' });
    }

    try {
      const outcome = await runScheduledMonthlySalaryAutomation();
      return res.json(outcome);
    } catch (error) {
      log.error('Cron-triggered monthly salary automation failed', error);
      return res.status(500).json({ code: 'cron_tick_failed' });
    }
  });
}
