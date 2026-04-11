import type { Express } from 'express';
import { createServer, type Server } from 'http';

import { registerDashboardRoutes } from './dashboard-routes';
import { registerAdminRoutes } from './routes/admin.routes';
import { registerAttendanceRoutes } from './routes/attendance.routes';
import { registerCalculationRulesRoutes } from './routes/calculationRules.routes';
import { registerEmployeeRoutes } from './routes/employees.routes';
import { registerHealthRoutes } from './routes/health.routes';
import { registerHolidayRoutes } from './routes/holidays.routes';
import { registerImportRoutes } from './routes/import.routes';
import { registerLineRoutes } from './routes/line.routes';
import { registerSalaryRoutes } from './routes/salary.routes';
import { registerScanRoutes } from './routes/scan.routes';
import { registerSettingsRoutes } from './routes/settings.routes';
import { registerTaiwanHolidaysRoutes } from './routes/taiwanHolidays.routes';
import { isLineConfigured } from './services/line.service';
import { createLogger } from './utils/logger';

const log = createLogger('routes');

export async function registerRoutes(app: Express): Promise<Server> {
  log.info('Registering application routes');

  registerDashboardRoutes(app);
  registerAdminRoutes(app);
  registerAttendanceRoutes(app);
  registerCalculationRulesRoutes(app);
  registerEmployeeRoutes(app);
  registerHealthRoutes(app);
  registerHolidayRoutes(app);
  registerImportRoutes(app);
  registerSalaryRoutes(app);
  registerScanRoutes(app);
  registerSettingsRoutes(app);
  registerTaiwanHolidaysRoutes(app);
  registerLineRoutes(app);

  if (isLineConfigured()) {
    log.info('LINE routes enabled');
  } else {
    log.warn('LINE routes registered in disabled mode because LINE env vars are missing');
  }

  const httpServer = createServer(app);
  return httpServer;
}
