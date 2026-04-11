import fs from 'fs';
import path from 'path';

import '../test-utils/load-env';
import { getBackupRootDir } from '../config/runtimePaths';
import { createLogger } from '../utils/logger';

const log = createLogger('restore-check');

const BACKUP_SUBDIRECTORIES = ['daily', 'weekly', 'monthly', 'manual'] as const;

function hasAnyBackupFiles(): boolean {
  const backupRootDir = getBackupRootDir();

  return BACKUP_SUBDIRECTORIES.some((directory) => {
    const candidateDir = path.join(backupRootDir, directory);
    if (!fs.existsSync(candidateDir)) {
      return false;
    }

    return fs.readdirSync(candidateDir, { withFileTypes: true }).some((entry) => entry.isFile());
  });
}

async function main() {
  if (!hasAnyBackupFiles()) {
    log.info('No backup files found. Skipping restore validation.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    log.warn('DATABASE_URL is not configured. Skipping restore validation because live database counts are unavailable.');
    return;
  }

  const [{ getBackupsList, getLiveDatabaseCounts, inspectBackupFileAtPath }, { sql }] = await Promise.all([
    import('../db-monitoring'),
    import('../db'),
  ]);

  const backups = await getBackupsList();
  const tryInspectBackup = (backup: (typeof backups)[number]) => {
    try {
      return inspectBackupFileAtPath(backup.path, {
        backupId: backup.id,
        backupType: backup.type
      });
    } catch (error) {
      log.warn('Skipping backup that could not be inspected', {
        backupId: backup.id,
        path: backup.path,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const inspectableBackups = backups
    .map((backup) => {
      const inspection = tryInspectBackup(backup);
      return inspection ? { backup, inspection } : null;
    })
    .filter((value): value is { backup: (typeof backups)[number]; inspection: ReturnType<typeof inspectBackupFileAtPath> } => value !== null);

  const restoreReadyBackup = inspectableBackups.find(({ inspection }) => inspection.errors.length === 0);

  if (!restoreReadyBackup) {
    log.error('No restore-ready backup was found.');
    process.exitCode = 1;
    return;
  }

  const inspection = restoreReadyBackup.inspection;
  const liveCounts = await getLiveDatabaseCounts();

  log.info('Latest backup passed restore readiness checks.', {
    backupId: inspection.backupId,
    type: inspection.backupType,
    path: inspection.path,
    metadata: inspection.metadata,
    backupCounts: inspection.counts,
    liveCounts,
    restoreOrder: inspection.restoreOrder,
    warnings: inspection.warnings
  });

  await sql.end({ timeout: 1 });
}

main()
  .catch((error) => {
    log.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
