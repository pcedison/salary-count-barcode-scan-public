import type { Express, Response } from 'express';

import {
  getAvailableLogDates,
  getOperationLogs,
  logOperation,
  OperationType,
  PermissionLevel
} from './admin-auth';
import {
  BackupType,
  checkDatabaseConnection,
  createDatabaseBackup,
  deleteBackup,
  getBackupsList,
  getConnectionHistory,
  restoreFromBackup,
  validateBackupId
} from './db-monitoring';
import { strictLimiter } from './middleware/rateLimiter';
import { requireAdmin } from './middleware/requireAdmin';
import { getOperationalMetricsSummary, recordCounter } from './observability/runtimeMetrics';
import { handleRouteError } from './routes/route-helpers';
import { createLogger } from './utils/logger';

const log = createLogger('dashboard');

function setNoStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

function parseBackupType(value?: string): BackupType | undefined {
  switch (value) {
    case 'daily':
      return BackupType.DAILY;
    case 'weekly':
      return BackupType.WEEKLY;
    case 'monthly':
      return BackupType.MONTHLY;
    case 'manual':
      return BackupType.MANUAL;
    default:
      return undefined;
  }
}

function handleDashboardError(res: Response, err: unknown, message: string) {
  log.error(message, err);
  return handleRouteError(err, res);
}

export function registerDashboardRoutes(app: Express) {
  const requireSuperAdmin = requireAdmin(PermissionLevel.SUPER);

  app.use('/api/dashboard/backups', (req, res, next) => {
    if (req.path.includes('..')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup id.'
      });
    }

    return next();
  });

  app.all(/^\/api\/dashboard\/secrets(?:\/.*)?$/, (_req, res) => {
    return res.status(400).json({
      success: false,
      message: 'Invalid backup id.'
    });
  });

  app.get('/api/dashboard/connection-history', requireSuperAdmin, async (_req, res) => {
    try {
      setNoStore(res);
      return res.json({
        success: true,
        data: getConnectionHistory()
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to load connection history');
    }
  });

  app.post('/api/dashboard/backups', strictLimiter, requireSuperAdmin, async (req, res) => {
    try {
      setNoStore(res);
      const type = typeof req.body?.type === 'string' ? req.body.type : 'manual';
      const description = typeof req.body?.description === 'string' ? req.body.description : undefined;
      const backupType = parseBackupType(type) ?? BackupType.MANUAL;
      const backupId = await createDatabaseBackup(
        backupType,
        description || `Dashboard ${type} backup`
      );

      logOperation(OperationType.BACKUP, `Created ${type} backup ${backupId}`, {
        success: true
      });
      recordCounter('backup.create.success');

      return res.json({
        success: true,
        message: 'Backup created successfully.',
        backupId,
        backupType: type
      });
    } catch (err) {
      recordCounter('backup.create.failure');
      logOperation(OperationType.BACKUP, 'Backup creation failed', {
        success: false,
        errorMessage: err instanceof Error ? err.message : 'unknown_error'
      });
      return handleDashboardError(res, err, 'Failed to create backup');
    }
  });

  app.get('/api/dashboard/backups', requireSuperAdmin, async (req, res) => {
    try {
      setNoStore(res);
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;
      return res.json({
        success: true,
        data: await getBackupsList(parseBackupType(type)),
        backupType: type || 'all'
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to list backups');
    }
  });

  app.post(/^\/api\/dashboard\/backups\/(.+)\/restore$/, strictLimiter, requireSuperAdmin, async (req, res) => {
    if (req.originalUrl.includes('..')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup id.'
      });
    }

    const backupId = req.params.backupId ?? req.params[0];
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'Backup id is required.'
      });
    }

    let safeBackupId: string;
    try {
      safeBackupId = validateBackupId(backupId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : 'Invalid backup id'
      });
    }

    try {
      setNoStore(res);
      const type = typeof req.body?.type === 'string' ? req.body.type : undefined;
      const backupType = parseBackupType(type);
      const currentBackupId = await createDatabaseBackup(
        BackupType.MANUAL,
        `Pre-restore safeguard ${new Date().toISOString()}`
      );

      await restoreFromBackup(safeBackupId, backupType, {
        skipPreRestoreBackup: true
      });

      logOperation(OperationType.RESTORE, `Restored backup ${safeBackupId}`, {
        success: true
      });
      recordCounter('backup.restore.success');

      return res.json({
        success: true,
        message: 'Backup restored successfully.',
        currentBackupId,
        restoredFrom: {
          backupId: safeBackupId,
          backupType: type || 'unknown'
        }
      });
    } catch (err) {
      recordCounter('backup.restore.failure');
      logOperation(OperationType.RESTORE, `Restore failed for backup ${safeBackupId}`, {
        success: false,
        errorMessage: err instanceof Error ? err.message : 'unknown_error'
      });
      return handleDashboardError(res, err, 'Failed to restore backup');
    }
  });

  app.get('/api/dashboard/logs', requireSuperAdmin, async (req, res) => {
    try {
      setNoStore(res);
      const date = typeof req.query.date === 'string' ? new Date(req.query.date) : undefined;
      const parsedDate = date && !Number.isNaN(date.getTime()) ? date : undefined;
      const type =
        typeof req.query.type === 'string' ? (req.query.type as OperationType) : undefined;

      return res.json({
        success: true,
        data: await getOperationLogs(parsedDate, type)
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to load dashboard logs');
    }
  });

  app.get('/api/dashboard/logs/dates', requireSuperAdmin, async (_req, res) => {
    try {
      setNoStore(res);
      return res.json({
        success: true,
        data: await getAvailableLogDates()
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to list dashboard log dates');
    }
  });

  app.get('/api/dashboard/operational-metrics', requireSuperAdmin, async (_req, res) => {
    try {
      setNoStore(res);
      return res.json({
        success: true,
        data: getOperationalMetricsSummary()
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to load operational metrics');
    }
  });

  app.post('/api/dashboard/sync', strictLimiter, requireSuperAdmin, async (_req, res) => {
    setNoStore(res);
    return res.status(409).json({
      success: false,
      message: 'Runtime database sync is disabled because production runs in PostgreSQL-only mode.',
      disabled: true
    });
  });

  app.get('/api/dashboard/consistency', requireSuperAdmin, async (_req, res) => {
    setNoStore(res);
    return res.status(409).json({
      success: false,
      message: 'Consistency repair is disabled because production runs in PostgreSQL-only mode.',
      disabled: true
    });
  });

  app.delete(/^\/api\/dashboard\/backups\/(.+)$/, strictLimiter, requireSuperAdmin, async (req, res) => {
    if (req.originalUrl.includes('..')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup id.'
      });
    }

    const backupId = req.params.backupId ?? req.params[0];
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'Backup id is required.'
      });
    }

    let safeBackupId: string;
    try {
      safeBackupId = validateBackupId(backupId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : 'Invalid backup id'
      });
    }

    try {
      setNoStore(res);
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;
      await deleteBackup(safeBackupId, parseBackupType(type));

      logOperation(OperationType.DELETE, `Deleted backup ${safeBackupId}`, {
        success: true
      });
      recordCounter('backup.delete.success');

      return res.json({
        success: true,
        message: `Deleted backup ${safeBackupId}.`
      });
    } catch (err) {
      recordCounter('backup.delete.failure');
      logOperation(OperationType.DELETE, `Delete failed for backup ${safeBackupId}`, {
        success: false,
        errorMessage: err instanceof Error ? err.message : 'unknown_error'
      });
      return handleDashboardError(res, err, 'Failed to delete backup');
    }
  });

  app.get('/api/dashboard/connection', requireSuperAdmin, async (_req, res) => {
    try {
      setNoStore(res);
      const status = await checkDatabaseConnection();

      return res.json({
        success: true,
        status
      });
    } catch (err) {
      return handleDashboardError(res, err, 'Failed to check dashboard database connection');
    }
  });
}
