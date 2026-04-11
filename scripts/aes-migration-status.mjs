import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import { aesDecrypt, aesEncrypt, deriveKey } from './lib/aes-crypto.mjs';
import {
  analyzeEmployeesForAesMigration,
  sanitizeAesMigrationReportForDisk
} from './lib/aes-migration-audit.mjs';
import {
  buildAesMigrationReadiness,
  loadAesMigrationArtifacts
} from './lib/aes-migration-readiness.mjs';
import { createPostgresClient } from './lib/postgres-client.mjs';

const REPORT_DIR = path.join(process.cwd(), 'backups', 'aes-migration', 'reports');

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeStatusReport(status, liveReport) {
  ensureDirectory(REPORT_DIR);

  const reportPath = path.join(
    REPORT_DIR,
    `aes-status-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  const payload = {
    metadata: {
      generatedAt: status.generatedAt,
      mode: 'status',
      databaseType: 'postgres'
    },
    readiness: status,
    liveAnalysis: sanitizeAesMigrationReportForDisk(liveReport)
  };

  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  return reportPath;
}

function logChecks(checks) {
  for (const check of checks) {
    console.log(`  [${check.ok ? 'OK' : 'FAIL'}] ${check.id} — ${check.detail}`);
  }
}

async function main() {
  const requireReady = process.argv.includes('--require-ready');
  const jsonMode = process.argv.includes('--json');
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey || encryptionKey.length < 32) {
    console.error('ERROR: ENCRYPTION_KEY must be set and >= 32 chars');
    process.exit(1);
  }

  const sql = createPostgresClient(process.env.DATABASE_URL);
  const aesKey = deriveKey(encryptionKey);

  try {
    const employees = await sql`
      SELECT id, name, id_number, is_encrypted
      FROM employees
      ORDER BY id
    `;

    const liveReport = analyzeEmployeesForAesMigration({
      employees,
      aesDecrypt: (encryptedValue) => aesDecrypt(encryptedValue, aesKey),
      aesEncrypt: (plaintextValue) => aesEncrypt(plaintextValue, aesKey)
    });
    const artifacts = loadAesMigrationArtifacts(process.cwd());
    const readiness = buildAesMigrationReadiness({
      liveReport,
      artifacts,
      env: {
        encryptionKeyConfigured: true,
        encryptionSaltConfigured: Boolean(process.env.ENCRYPTION_SALT),
        useAesEncryption: process.env.USE_AES_ENCRYPTION === 'true'
      }
    });
    const reportPath = writeStatusReport(readiness, liveReport);

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            readiness,
            reportPath
          },
          null,
          2
        )
      );
    } else {
      console.log('\n=== AES Migration Status ===\n');
      console.log(`Employees scanned: ${liveReport.counts.total}`);
      console.log(`Ready for execute: ${readiness.ready ? 'YES' : 'NO'}`);
      console.log(`Live counts: ${JSON.stringify(readiness.liveCounts)}`);
      console.log('');
      logChecks(readiness.checks);

      if (readiness.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of readiness.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      if (readiness.failures.length > 0) {
        console.log('\nBlocking issues:');
        for (const failure of readiness.failures) {
          console.log(`  - ${failure}`);
        }
      }

      console.log(`\nNext action: ${readiness.nextAction}`);
      console.log(`Status report saved: ${reportPath}`);
    }

    if (requireReady && !readiness.ready) {
      process.exit(1);
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error('AES migration status failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
