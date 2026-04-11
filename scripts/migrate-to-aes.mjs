/**
 * AES 加密遷移工具
 *
 * 將員工 ID 從明文或 Caesar 加密遷移到 AES-256-GCM 加密。
 *
 * Usage:
 *   node scripts/migrate-to-aes.mjs                           # dry-run（預覽）
 *   node scripts/migrate-to-aes.mjs --snapshot               # 建立遷移前快照
 *   node scripts/migrate-to-aes.mjs --rehearse              # 非破壞式 migrate + rollback 演練
 *   node scripts/migrate-to-aes.mjs --execute --operator ops --allow-remote
 *                                                        # 執行正式遷移
 *   node scripts/migrate-to-aes.mjs --rollback --allow-remote
 *                                                        # 從備份回滾
 *
 * Optional filters:
 *   --employee-id=1,2,3
 *   --employee-id 1 --employee-id 2
 *   --operator Marcus
 *   --allow-remote
 *
 * Required env vars:
 *   DATABASE_URL      — PostgreSQL connection string
 *   ENCRYPTION_KEY    — AES key (>= 32 chars)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import {
  analyzeEmployeesForAesMigration,
  maskIdentifier,
  sanitizeAesMigrationReportForDisk
} from './lib/aes-migration-audit.mjs';
import { aesDecrypt, aesEncrypt, deriveKey } from './lib/aes-crypto.mjs';
import {
  describeDatabaseTarget,
  resolveAesMigrationOperator,
  validateAesMutationRequest
} from './lib/aes-migration-guard.mjs';
import { createPostgresClient } from './lib/postgres-client.mjs';
const BACKUP_DIR = path.join(process.cwd(), 'backups', 'aes-migration');
const REPORT_DIR = path.join(BACKUP_DIR, 'reports');

class AesRehearsalRollback extends Error {
  constructor(summary) {
    super('AES_REHEARSAL_ROLLBACK');
    this.name = 'AesRehearsalRollback';
    this.summary = summary;
  }
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readOptionValues(flag) {
  const values = [];

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];

    if (arg === flag) {
      const next = process.argv[index + 1];
      if (next && !next.startsWith('--')) {
        values.push(next);
      }
      continue;
    }

    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }

  return values;
}

function parseEmployeeIds() {
  return Array.from(
    new Set(
      readOptionValues('--employee-id')
        .flatMap((value) => value.split(','))
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ).sort((left, right) => left - right);
}

function createReportMetadata(mode, employeesCount, selectedEmployeeIds, context = {}) {
  return {
    generatedAt: new Date().toISOString(),
    mode,
    databaseType: 'postgres',
    employeesScanned: employeesCount,
    selectedEmployeeIds,
    encryptionKeyConfigured: Boolean(process.env.ENCRYPTION_KEY),
    encryptionSaltConfigured: Boolean(process.env.ENCRYPTION_SALT),
    useAesEncryption: process.env.USE_AES_ENCRYPTION === 'true',
    operator: context.operator ?? null,
    allowRemote: context.allowRemote ?? false,
    databaseTarget: context.databaseTarget ?? null
  };
}

function buildRecommendations(report) {
  return {
    requiresManualBackupBeforeExecute: report.counts.toMigrate > 0,
    requiresRestoreDrillRecord: report.counts.toMigrate > 0,
    requiresSnapshotBeforeExecute: report.counts.toMigrate > 0,
    flagMismatchCount: report.counts.flagMismatches,
    migrationCandidateCount: report.counts.toMigrate,
    blocked: report.findings.migrationCandidates.some((candidate) => candidate.roundTripOk !== true)
  };
}

function writeMigrationReport(options) {
  const {
    mode,
    employeesCount,
    report,
    selectedEmployeeIds,
    extra = {},
    context = {}
  } = options;
  ensureDirectory(REPORT_DIR);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `aes-${mode}-report-${timestamp}.json`);
  const reportPayload = {
    metadata: createReportMetadata(mode, employeesCount, selectedEmployeeIds, context),
    counts: report.counts,
    recommendations: buildRecommendations(report),
    findings: sanitizeAesMigrationReportForDisk(report).findings,
    ...extra
  };

  fs.writeFileSync(reportPath, JSON.stringify(reportPayload, null, 2));
  return reportPath;
}

function buildSnapshotBackupData(migrationCandidates) {
  return migrationCandidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    idNumber: candidate.oldIdNumber,
    isEncrypted: candidate.oldIsEncrypted
  }));
}

function createSnapshotBackup(migrationCandidates) {
  ensureDirectory(BACKUP_DIR);

  const backupPath = path.join(
    BACKUP_DIR,
    `pre-aes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(backupPath, JSON.stringify(buildSnapshotBackupData(migrationCandidates), null, 2));
  return backupPath;
}

function maskStoredIdentifier(value) {
  return maskIdentifier(value);
}

function filterEmployeesByIds(employees, requestedEmployeeIds) {
  if (requestedEmployeeIds.length === 0) {
    return employees;
  }

  const requestedIds = new Set(requestedEmployeeIds);
  return employees.filter((employee) => requestedIds.has(employee.id));
}

function logReportSummary(report, skipped) {
  console.log('Source formats:');
  console.log('  Plaintext:', report.counts.plaintext);
  console.log('  Caesar:', report.counts.caesar);
  console.log('  AES:', report.counts.aes);
  console.log('  Empty:', report.counts.empty);
  console.log('Already AES:', report.counts.alreadyAes);
  console.log('To migrate:', report.counts.toMigrate);
  console.log('Skipped:', report.counts.skipped);
  console.log('Flag mismatches:', report.counts.flagMismatches);

  for (const skippedItem of skipped) {
    console.log(`  SKIP: ID ${skippedItem.id} (${skippedItem.name}) — ${skippedItem.reason}`);
  }
  console.log('');
}

function logMigrationCandidates(migrationCandidates, key, options = {}) {
  const { includeCiphertextPreview = true } = options;

  for (const candidate of migrationCandidates) {
    console.log(
      `  MIGRATE: ID ${candidate.id} (${candidate.name}) — ${candidate.maskedPlaintextId} | source=${candidate.sourceFormat}`
    );
    console.log(`    from: ${candidate.maskedStoredId} (encrypted=${candidate.oldIsEncrypted})`);

    if (includeCiphertextPreview) {
      console.log(`    to:   ${candidate.newCiphertext.slice(0, 30)}... (encrypted=true)`);
    }

    const roundTrip = aesDecrypt(candidate.newCiphertext, key);
    if (roundTrip !== candidate.plaintextId) {
      throw new Error(
        `ROUND-TRIP FAILED: expected ${candidate.maskedPlaintextId}, got ${roundTrip.length} chars`
      );
    }
    console.log('    round-trip: OK');
  }
}

async function rehearseAesMigration(sql, key, migrationCandidates) {
  try {
    await sql.begin(async (tx) => {
      for (const candidate of migrationCandidates) {
        await tx`
          UPDATE employees
          SET id_number = ${candidate.newCiphertext}, is_encrypted = true
          WHERE id = ${candidate.id}
        `;
      }

      for (const candidate of migrationCandidates) {
        const [row] = await tx`
          SELECT id_number, is_encrypted
          FROM employees
          WHERE id = ${candidate.id}
        `;

        const decrypted = aesDecrypt(row.id_number, key);
        if (decrypted !== candidate.plaintextId || row.is_encrypted !== true) {
          throw new Error(`rehearsal migrate verify failed for employee ${candidate.id}`);
        }
      }

      for (const candidate of migrationCandidates) {
        await tx`
          UPDATE employees
          SET id_number = ${candidate.oldIdNumber}, is_encrypted = ${candidate.oldIsEncrypted}
          WHERE id = ${candidate.id}
        `;
      }

      for (const candidate of migrationCandidates) {
        const [row] = await tx`
          SELECT id_number, is_encrypted
          FROM employees
          WHERE id = ${candidate.id}
        `;

        if (
          row.id_number !== candidate.oldIdNumber ||
          Boolean(row.is_encrypted) !== Boolean(candidate.oldIsEncrypted)
        ) {
          throw new Error(`rehearsal rollback verify failed for employee ${candidate.id}`);
        }
      }

      throw new AesRehearsalRollback({
        candidateCount: migrationCandidates.length,
        migratedCount: migrationCandidates.length,
        rolledBackCount: migrationCandidates.length,
        migrationVerified: true,
        rollbackVerified: true,
        rehearsalRolledBack: true
      });
    });

    throw new Error('AES rehearsal did not trigger rollback');
  } catch (error) {
    if (error instanceof AesRehearsalRollback) {
      return error.summary;
    }

    throw error;
  }
}

async function rollback(sql) {
  console.log('\n=== AES Migration ROLLBACK ===\n');

  if (!fs.existsSync(BACKUP_DIR)) {
    console.error('No backup directory found. Cannot rollback.');
    process.exit(1);
  }

  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error('No backup files found. Cannot rollback.');
    process.exit(1);
  }

  const latestBackup = path.join(BACKUP_DIR, files[0]);
  console.log(`Rolling back from: ${latestBackup}\n`);

  const backupData = JSON.parse(fs.readFileSync(latestBackup, 'utf-8'));

  for (const record of backupData) {
    await sql`
      UPDATE employees
      SET id_number = ${record.idNumber}, is_encrypted = ${record.isEncrypted ?? false}
      WHERE id = ${record.id}
    `;
    console.log(`  Restored ID ${record.id} (${record.name}): ${maskStoredIdentifier(record.idNumber)}`);
  }

  console.log(`\n=== Rollback complete. ${backupData.length} employees restored. ===`);
}

async function main() {
  const rawArgs = new Set(process.argv.slice(2));
  const selectedEmployeeIds = parseEmployeeIds();
  const operator = resolveAesMigrationOperator(readOptionValues('--operator').at(-1));
  const isRollback = rawArgs.has('--rollback');
  const isExecute = rawArgs.has('--execute');
  const isSnapshot = rawArgs.has('--snapshot');
  const isRehearsal = rawArgs.has('--rehearse');
  const allowRemote =
    rawArgs.has('--allow-remote') || process.env.AES_MIGRATION_ALLOW_REMOTE === 'true';
  const activeModes = [isRollback, isExecute, isSnapshot, isRehearsal].filter(Boolean).length;

  if (activeModes > 1) {
    console.error('ERROR: --rollback / --execute / --snapshot / --rehearse 只能擇一');
    process.exit(1);
  }

  const isDryRun = activeModes === 0;
  const reportMode = isRollback
    ? 'rollback'
    : isExecute
      ? 'execute-plan'
      : isSnapshot
        ? 'snapshot'
        : isRehearsal
        ? 'rehearsal'
          : 'dry-run';

  const databaseTarget = describeDatabaseTarget(process.env.DATABASE_URL ?? '');
  validateAesMutationRequest({
    mode: isRollback ? 'rollback' : isExecute ? 'execute' : reportMode,
    databaseUrl: process.env.DATABASE_URL ?? '',
    allowRemote,
    operator,
    useAesEncryption: process.env.USE_AES_ENCRYPTION === 'true',
    encryptionSaltConfigured: Boolean(process.env.ENCRYPTION_SALT)
  });

  if (isExecute || isRollback) {
    console.log(
      `Target database: ${databaseTarget.host ?? 'unknown'}/${databaseTarget.database ?? 'unknown'} ${databaseTarget.isRemote ? '(remote)' : '(local)'}`
    );
  }

  const sql = createPostgresClient(process.env.DATABASE_URL);

  try {
    if (isRollback) {
      await rollback(sql);
      return;
    }

    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey || encryptionKey.length < 32) {
      console.error('ERROR: ENCRYPTION_KEY must be set and >= 32 chars');
      console.error('Set it in .env: ENCRYPTION_KEY=your-32+-char-secret-key-here...');
      process.exit(1);
    }

    const aesKey = deriveKey(encryptionKey);

    console.log(
      `\n=== AES Migration ${isDryRun ? '(DRY RUN)' : isSnapshot ? '(SNAPSHOT)' : isRehearsal ? '(REHEARSAL)' : '(EXECUTE)'} ===\n`
    );

    const allEmployees = await sql`
      SELECT id, name, id_number, is_encrypted
      FROM employees
      ORDER BY id
    `;
    const employees = filterEmployeesByIds(allEmployees, selectedEmployeeIds);

    if (selectedEmployeeIds.length > 0 && employees.length === 0) {
      throw new Error(`No employees matched requested IDs: ${selectedEmployeeIds.join(', ')}`);
    }

    console.log(
      `Found ${employees.length} employees${selectedEmployeeIds.length > 0 ? ` (filtered from ${allEmployees.length})` : ''}\n`
    );

    const report = analyzeEmployeesForAesMigration({
      employees,
      aesDecrypt: (encryptedValue) => aesDecrypt(encryptedValue, aesKey),
      aesEncrypt: (plaintextValue) => aesEncrypt(plaintextValue, aesKey)
    });
    const migrationCandidates = report.findings.migrationCandidates;
    const skipped = report.findings.skipped;

    logReportSummary(report, skipped);

    if (migrationCandidates.length === 0) {
      // Even with 0 candidates, write mode-appropriate metadata so the readiness
      // checker can confirm the pipeline ran and found nothing to do.
      const extra = isSnapshot
        ? { snapshot: { snapshotPath: null, snapshotRecords: 0 } }
        : isRehearsal
          ? {
              rehearsal: {
                candidateCount: 0,
                migratedCount: 0,
                rolledBackCount: 0,
                migrationVerified: true,
                rollbackVerified: true,
                rehearsalRolledBack: true
              }
            }
          : {};

      const reportPath = writeMigrationReport({
        mode: reportMode,
        employeesCount: employees.length,
        report,
        selectedEmployeeIds,
        context: { operator, allowRemote, databaseTarget },
        extra
      });
      console.log(`Report saved: ${reportPath}`);
      console.log('\nNothing to migrate.');
      return;
    }

    logMigrationCandidates(migrationCandidates, aesKey);

    if (isDryRun) {
      const reportPath = writeMigrationReport({
        mode: reportMode,
        employeesCount: employees.length,
        report,
        selectedEmployeeIds,
        context: {
          operator,
          allowRemote,
          databaseTarget
        }
      });
      console.log(`\nReport saved: ${reportPath}`);
      console.log('\n--- DRY RUN complete. Use --snapshot, --rehearse, or --execute to continue. ---');
      return;
    }

    if (isSnapshot) {
      const snapshotPath = createSnapshotBackup(migrationCandidates);
      const reportPath = writeMigrationReport({
        mode: reportMode,
        employeesCount: employees.length,
        report,
        selectedEmployeeIds,
        context: {
          operator,
          allowRemote,
          databaseTarget
        },
        extra: {
          snapshot: {
            snapshotPath,
            snapshotRecords: migrationCandidates.length
          }
        }
      });

      console.log(`\nSnapshot saved: ${snapshotPath}`);
      console.log(`Report saved: ${reportPath}`);
      return;
    }

    if (isRehearsal) {
      const rehearsal = await rehearseAesMigration(sql, aesKey, migrationCandidates);
      const reportPath = writeMigrationReport({
        mode: reportMode,
        employeesCount: employees.length,
        report,
        selectedEmployeeIds,
        context: {
          operator,
          allowRemote,
          databaseTarget
        },
        extra: {
          rehearsal
        }
      });

      console.log('\nRehearsal summary:');
      console.log(JSON.stringify(rehearsal, null, 2));
      console.log(`Report saved: ${reportPath}`);
      return;
    }

    const backupPath = createSnapshotBackup(migrationCandidates);
    const reportPath = writeMigrationReport({
      mode: reportMode,
      employeesCount: employees.length,
      report,
      selectedEmployeeIds,
      context: {
        operator,
        allowRemote,
        databaseTarget
      },
      extra: {
        snapshot: {
          snapshotPath: backupPath,
          snapshotRecords: migrationCandidates.length
        }
      }
    });

    console.log(`\nBackup saved: ${backupPath}`);
    console.log(`Report saved: ${reportPath}`);
    console.log(`Operator: ${operator}`);

    console.log('\nMigrating...');
    for (const candidate of migrationCandidates) {
      await sql`
        UPDATE employees
        SET id_number = ${candidate.newCiphertext}, is_encrypted = true
        WHERE id = ${candidate.id}
      `;
      console.log(`  Updated ID ${candidate.id} (${candidate.name})`);
    }

    console.log('\nVerifying...');
    for (const candidate of migrationCandidates) {
      const [row] = await sql`
        SELECT id_number, is_encrypted
        FROM employees
        WHERE id = ${candidate.id}
      `;
      const decrypted = aesDecrypt(row.id_number, aesKey);

      if (decrypted !== candidate.plaintextId) {
        console.error(
          `  VERIFY FAILED: ID ${candidate.id} — expected ${candidate.maskedPlaintextId}, got ${decrypted.length} chars`
        );
        console.error('  Run --rollback to revert');
        process.exit(1);
      }

      console.log(`  Verified ID ${candidate.id}: ${candidate.maskedPlaintextId} (OK)`);
    }

    console.log(`\n=== Migration complete. ${migrationCandidates.length} employees encrypted with AES. ===`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
