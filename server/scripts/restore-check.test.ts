import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getRestoreSkipDecision,
  hasAnyBackupFiles,
  parseRestoreCheckOptions
} from './restore-check';

const tempDirs: string[] = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-check-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('restore-check options', () => {
  it('keeps the default local restore check skippable when no backup is present', () => {
    const options = parseRestoreCheckOptions([], {});
    const decision = getRestoreSkipDecision('missing-backup-files', options);

    expect(options.requireBackup).toBe(false);
    expect(decision).toEqual({
      level: 'info',
      message: 'No backup files found. Skipping restore validation.',
      exitCode: 0
    });
  });

  it('fails missing backup artifacts when strict restore validation is requested', () => {
    const options = parseRestoreCheckOptions(['--require-backup'], {});
    const decision = getRestoreSkipDecision('missing-backup-files', options);

    expect(options.requireBackup).toBe(true);
    expect(decision).toEqual({
      level: 'error',
      message: 'No backup files found. Restore validation requires a backup artifact.',
      exitCode: 1
    });
  });

  it('also enables strict restore validation from the environment', () => {
    const options = parseRestoreCheckOptions([], {
      RESTORE_CHECK_REQUIRE_BACKUP: 'true'
    });
    const decision = getRestoreSkipDecision('missing-database-url', options);

    expect(options.requireBackup).toBe(true);
    expect(decision).toEqual({
      level: 'error',
      message:
        'DATABASE_URL is not configured. Restore validation requires live database counts.',
      exitCode: 1
    });
  });

  it('detects backup files under the managed backup subdirectories', () => {
    const backupRootDir = createTempDir();
    expect(hasAnyBackupFiles(backupRootDir)).toBe(false);

    const manualBackupDir = path.join(backupRootDir, 'manual');
    fs.mkdirSync(manualBackupDir, { recursive: true });
    fs.writeFileSync(path.join(manualBackupDir, 'backup-manual-test.json'), '{}');

    expect(hasAnyBackupFiles(backupRootDir)).toBe(true);
  });
});
