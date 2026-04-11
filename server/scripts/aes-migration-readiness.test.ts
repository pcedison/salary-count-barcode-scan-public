import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAesMigrationReadiness,
  loadAesMigrationArtifacts
} from '../../scripts/lib/aes-migration-readiness.mjs';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createLiveReport(counts) {
  return {
    counts,
    findings: {
      flagMismatches: [],
      alreadyAes: [],
      migrationCandidates: [],
      skipped: []
    }
  };
}

const createdDirs = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('aes migration readiness', () => {
  it('selects the latest full-scope artifacts and marks readiness green when evidence aligns', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aes-readiness-'));
    createdDirs.push(tempDir);

    const counts = {
      total: 2,
      plaintext: 2,
      caesar: 0,
      aes: 0,
      empty: 0,
      alreadyAes: 0,
      toMigrate: 2,
      skipped: 0,
      flagMismatches: 0
    };
    const restoreCounts = {
      employees: 2,
      holidays: 0,
      pendingBindings: 1,
      salaryRecords: 11,
      temporaryAttendance: 0,
      hasSettings: true
    };
    const snapshotPath = path.join(tempDir, 'backups', 'aes-migration', 'pre-aes-good.json');

    writeJson(snapshotPath, [{ id: 1, name: 'Alice' }]);
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-dry-run-report-2026-03-15T10-00-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:00:00.000Z', mode: 'dry-run' },
        counts,
        recommendations: { blocked: false }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-snapshot-report-2026-03-15T10-10-00-000Z.json'
      ),
      {
        metadata: {
          generatedAt: '2026-03-15T10:10:00.000Z',
          mode: 'snapshot',
          selectedEmployeeIds: [999]
        },
        counts,
        snapshot: {
          snapshotPath,
          snapshotRecords: 1
        }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-snapshot-report-2026-03-15T10-05-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:05:00.000Z', mode: 'snapshot' },
        counts,
        snapshot: {
          snapshotPath,
          snapshotRecords: 2
        }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-rehearsal-report-2026-03-15T10-20-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:20:00.000Z', mode: 'rehearsal' },
        counts,
        rehearsal: {
          candidateCount: 2,
          migratedCount: 2,
          rolledBackCount: 2,
          rehearsalRolledBack: true
        }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'restore-rehearsal',
        'reports',
        'restore-rehearsal-2026-03-15T10-30-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:30:00.000Z', mode: 'restore-rehearsal' },
        result: {
          backupCounts: restoreCounts,
          liveCountsBefore: restoreCounts,
          restoredCountsInTransaction: restoreCounts,
          rehearsalRolledBack: true
        }
      }
    );

    const artifacts = loadAesMigrationArtifacts(tempDir);
    const readiness = buildAesMigrationReadiness({
      liveReport: createLiveReport(counts),
      artifacts,
      env: {
        encryptionKeyConfigured: true,
        encryptionSaltConfigured: false,
        useAesEncryption: true
      }
    });

    expect(artifacts.snapshot.preferred?.path).toContain('10-05-00-000Z');
    expect(readiness.ready).toBe(true);
    expect(readiness.failures).toEqual([]);
    expect(readiness.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('latest snapshot artifact is filtered or unusable')
      ])
    );
  });

  it('fails readiness when dry-run evidence drifts from live analysis and rehearsal proof is missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aes-readiness-'));
    createdDirs.push(tempDir);

    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-dry-run-report-2026-03-15T11-00-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T11:00:00.000Z', mode: 'dry-run' },
        counts: {
          total: 2,
          plaintext: 2,
          caesar: 0,
          aes: 0,
          empty: 0,
          alreadyAes: 0,
          toMigrate: 2,
          skipped: 0,
          flagMismatches: 0
        },
        recommendations: { blocked: false }
      }
    );

    const artifacts = loadAesMigrationArtifacts(tempDir);
    const readiness = buildAesMigrationReadiness({
      liveReport: createLiveReport({
        total: 2,
        plaintext: 1,
        caesar: 0,
        aes: 1,
        empty: 0,
        alreadyAes: 1,
        toMigrate: 1,
        skipped: 0,
        flagMismatches: 0
      }),
      artifacts,
      env: {
        encryptionKeyConfigured: true,
        encryptionSaltConfigured: true,
        useAesEncryption: true
      }
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(
      expect.arrayContaining([
        'latest live analysis does not match dry-run counts',
        'missing snapshot artifact',
        'missing rehearsal artifact',
        'missing restore rehearsal artifact'
      ])
    );
  });

  it('fails readiness when USE_AES_ENCRYPTION is not enabled for post-migration writes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aes-readiness-'));
    createdDirs.push(tempDir);

    const counts = {
      total: 2,
      plaintext: 2,
      caesar: 0,
      aes: 0,
      empty: 0,
      alreadyAes: 0,
      toMigrate: 2,
      skipped: 0,
      flagMismatches: 0
    };
    const snapshotPath = path.join(tempDir, 'backups', 'aes-migration', 'pre-aes-good.json');

    writeJson(snapshotPath, [{ id: 1, name: 'Alice' }]);
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-dry-run-report-2026-03-15T10-00-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:00:00.000Z', mode: 'dry-run' },
        counts,
        recommendations: { blocked: false }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-snapshot-report-2026-03-15T10-05-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:05:00.000Z', mode: 'snapshot' },
        counts,
        snapshot: {
          snapshotPath,
          snapshotRecords: 2
        }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'aes-migration',
        'reports',
        'aes-rehearsal-report-2026-03-15T10-20-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:20:00.000Z', mode: 'rehearsal' },
        counts,
        rehearsal: {
          candidateCount: 2,
          migratedCount: 2,
          rolledBackCount: 2,
          rehearsalRolledBack: true
        }
      }
    );
    writeJson(
      path.join(
        tempDir,
        'backups',
        'restore-rehearsal',
        'reports',
        'restore-rehearsal-2026-03-15T10-30-00-000Z.json'
      ),
      {
        metadata: { generatedAt: '2026-03-15T10:30:00.000Z', mode: 'restore-rehearsal' },
        result: {
          backupCounts: {
            employees: 2,
            holidays: 0,
            pendingBindings: 1,
            salaryRecords: 11,
            temporaryAttendance: 0,
            hasSettings: true
          },
          liveCountsBefore: {
            employees: 2,
            holidays: 0,
            pendingBindings: 1,
            salaryRecords: 11,
            temporaryAttendance: 0,
            hasSettings: true
          },
          restoredCountsInTransaction: {
            employees: 2,
            holidays: 0,
            pendingBindings: 1,
            salaryRecords: 11,
            temporaryAttendance: 0,
            hasSettings: true
          },
          rehearsalRolledBack: true
        }
      }
    );

    const artifacts = loadAesMigrationArtifacts(tempDir);
    const readiness = buildAesMigrationReadiness({
      liveReport: createLiveReport(counts),
      artifacts,
      env: {
        encryptionKeyConfigured: true,
        encryptionSaltConfigured: true,
        useAesEncryption: false
      }
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(
      expect.arrayContaining([
        'USE_AES_ENCRYPTION=true must be set before execute so new writes stay on AES'
      ])
    );
  });
});
