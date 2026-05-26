import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import '../test-utils/load-env';
import { getBackupRootDir } from '../config/runtimePaths';
import { createLogger } from '../utils/logger';

const log = createLogger('restore-check');

const BACKUP_SUBDIRECTORIES = ['daily', 'weekly', 'monthly', 'manual'] as const;

interface RestoreCheckOptions {
  requireBackup: boolean;
}

type SkipReason = 'missing-backup-files' | 'missing-database-url';

interface SkipDecision {
  level: 'info' | 'warn' | 'error';
  message: string;
  exitCode: 0 | 1;
}

export function parseRestoreCheckOptions(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): RestoreCheckOptions {
  return {
    requireBackup:
      argv.includes('--require-backup') ||
      env.RESTORE_CHECK_REQUIRE_BACKUP?.trim().toLowerCase() === 'true'
  };
}

export function hasAnyBackupFiles(backupRootDir = getBackupRootDir()): boolean {

  return BACKUP_SUBDIRECTORIES.some((directory) => {
    const candidateDir = path.join(backupRootDir, directory);
    if (!fs.existsSync(candidateDir)) {
      return false;
    }

    return fs.readdirSync(candidateDir, { withFileTypes: true }).some((entry) => entry.isFile());
  });
}

export function getRestoreSkipDecision(
  reason: SkipReason,
  options: RestoreCheckOptions
): SkipDecision {
  if (reason === 'missing-backup-files') {
    return options.requireBackup
      ? {
          level: 'error',
          message:
            'No backup files found. Restore validation requires a backup artifact.',
          exitCode: 1
        }
      : {
          level: 'info',
          message: 'No backup files found. Skipping restore validation.',
          exitCode: 0
        };
  }

  return options.requireBackup
    ? {
        level: 'error',
        message:
          'DATABASE_URL is not configured. Restore validation requires live database counts.',
        exitCode: 1
      }
    : {
        level: 'warn',
        message:
          'DATABASE_URL is not configured. Skipping restore validation because live database counts are unavailable.',
        exitCode: 0
      };
}

function applySkipDecision(decision: SkipDecision) {
  log[decision.level](decision.message);
  if (decision.exitCode !== 0) {
    process.exitCode = decision.exitCode;
  }
}

async function main() {
  const options = parseRestoreCheckOptions();

  if (!hasAnyBackupFiles()) {
    applySkipDecision(getRestoreSkipDecision('missing-backup-files', options));
    return;
  }

  if (!process.env.DATABASE_URL) {
    applySkipDecision(getRestoreSkipDecision('missing-database-url', options));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      log.error('Failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
