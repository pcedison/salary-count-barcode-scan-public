import fs from 'fs';
import path from 'path';

const AES_REPORT_DIR = path.join('backups', 'aes-migration', 'reports');
const RESTORE_REHEARSAL_REPORT_DIR = path.join('backups', 'restore-rehearsal', 'reports');
const LIVE_COUNT_KEYS = [
  'total',
  'plaintext',
  'caesar',
  'aes',
  'empty',
  'alreadyAes',
  'toMigrate',
  'skipped',
  'flagMismatches'
];
const RESTORE_COUNT_KEYS = [
  'employees',
  'holidays',
  'pendingBindings',
  'salaryRecords',
  'temporaryAttendance',
  'hasSettings'
];

function toAbsoluteDir(baseDir, relativeDir) {
  return path.join(baseDir, relativeDir);
}

function safeSelectedEmployeeIds(report) {
  return Array.isArray(report?.metadata?.selectedEmployeeIds)
    ? report.metadata.selectedEmployeeIds
    : [];
}

function isFullScopeReport(report) {
  return safeSelectedEmployeeIds(report).length === 0;
}

function readJsonArtifact(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      path: filePath,
      fileName: path.basename(filePath),
      data,
      error: null
    };
  } catch (error) {
    return {
      path: filePath,
      fileName: path.basename(filePath),
      data: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function listArtifacts(dir, prefix) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
    .sort()
    .reverse()
    .map((file) => readJsonArtifact(path.join(dir, file)));
}

function summarizeArtifact(artifact) {
  if (!artifact) {
    return {
      present: false,
      path: null,
      generatedAt: null,
      mode: null,
      fullScope: false,
      selectedEmployeeIds: [],
      counts: null,
      error: null
    };
  }

  return {
    present: Boolean(artifact.data) && !artifact.error,
    path: artifact.path,
    generatedAt: artifact.data?.metadata?.generatedAt ?? null,
    mode: artifact.data?.metadata?.mode ?? null,
    fullScope: Boolean(artifact.data) && isFullScopeReport(artifact.data),
    selectedEmployeeIds: safeSelectedEmployeeIds(artifact.data),
    counts: artifact.data?.counts ?? null,
    error: artifact.error
  };
}

function pickCounts(counts, keys) {
  return Object.fromEntries(keys.map((key) => [key, counts?.[key] ?? null]));
}

function areCountsEqual(left, right, keys) {
  return keys.every((key) => left?.[key] === right?.[key]);
}

function createCheck(id, ok, detail) {
  return { id, ok, detail };
}

function selectPreferredArtifact(artifacts, { requireFullScope = true } = {}) {
  return (
    artifacts.find(
      (artifact) =>
        artifact.data &&
        !artifact.error &&
        (!requireFullScope || isFullScopeReport(artifact.data))
    ) ?? null
  );
}

function describeMissingArtifact(artifacts, label) {
  const latestAny = artifacts[0] ?? null;

  if (!latestAny) {
    return `missing ${label} artifact`;
  }

  if (latestAny.error) {
    return `${label} artifact parse failed: ${latestAny.error}`;
  }

  if (!isFullScopeReport(latestAny.data)) {
    return `${label} artifact exists but latest full-scope report is missing (latest report is filtered)`;
  }

  return `missing readable ${label} artifact`;
}

export function loadAesMigrationArtifacts(baseDir = process.cwd()) {
  const dryRunArtifacts = listArtifacts(
    toAbsoluteDir(baseDir, AES_REPORT_DIR),
    'aes-dry-run-report-'
  );
  const snapshotArtifacts = listArtifacts(
    toAbsoluteDir(baseDir, AES_REPORT_DIR),
    'aes-snapshot-report-'
  );
  const rehearsalArtifacts = listArtifacts(
    toAbsoluteDir(baseDir, AES_REPORT_DIR),
    'aes-rehearsal-report-'
  );
  const restoreRehearsalArtifacts = listArtifacts(
    toAbsoluteDir(baseDir, RESTORE_REHEARSAL_REPORT_DIR),
    'restore-rehearsal-'
  );

  return {
    dryRun: {
      preferred: selectPreferredArtifact(dryRunArtifacts),
      latestAny: dryRunArtifacts[0] ?? null
    },
    snapshot: {
      preferred: selectPreferredArtifact(snapshotArtifacts),
      latestAny: snapshotArtifacts[0] ?? null
    },
    rehearsal: {
      preferred: selectPreferredArtifact(rehearsalArtifacts),
      latestAny: rehearsalArtifacts[0] ?? null
    },
    restoreRehearsal: {
      preferred: selectPreferredArtifact(restoreRehearsalArtifacts, { requireFullScope: false }),
      latestAny: restoreRehearsalArtifacts[0] ?? null
    }
  };
}

export function buildAesMigrationReadiness(options) {
  const { liveReport, artifacts, env } = options;
  const dryRun = artifacts.dryRun.preferred?.data ?? null;
  const snapshot = artifacts.snapshot.preferred?.data ?? null;
  const rehearsal = artifacts.rehearsal.preferred?.data ?? null;
  const restoreRehearsal = artifacts.restoreRehearsal.preferred?.data ?? null;
  const liveCounts = pickCounts(liveReport?.counts, LIVE_COUNT_KEYS);
  const checks = [];
  const warnings = [];

  checks.push(
    createCheck(
      'env.encryption_key',
      env.encryptionKeyConfigured,
      env.encryptionKeyConfigured
        ? 'ENCRYPTION_KEY configured'
        : 'ENCRYPTION_KEY is missing or shorter than 32 characters'
    )
  );

  checks.push(
    createCheck(
      'env.use_aes_encryption',
      env.useAesEncryption === true,
      env.useAesEncryption === true
        ? 'USE_AES_ENCRYPTION=true configured for post-migration writes'
        : 'USE_AES_ENCRYPTION=true must be set before execute so new writes stay on AES'
    )
  );

  if (!env.encryptionSaltConfigured) {
    warnings.push('ENCRYPTION_SALT 未設定，目前仍會使用預設 salt；正式 execute 前應補上明確 salt。');
  }

  checks.push(
    createCheck(
      'artifact.dry_run',
      Boolean(dryRun),
      dryRun
        ? `dry-run report ready: ${artifacts.dryRun.preferred.path}`
        : describeMissingArtifact(
            artifacts.dryRun.latestAny ? [artifacts.dryRun.latestAny] : [],
            'dry-run'
          )
    )
  );

  if (dryRun) {
    checks.push(
      createCheck(
        'dry_run.not_blocked',
        dryRun.recommendations?.blocked !== true,
        dryRun.recommendations?.blocked !== true
          ? 'dry-run candidates all passed round-trip validation'
          : 'dry-run report contains blocked migration candidates'
      )
    );
    checks.push(
      createCheck(
        'dry_run.flag_mismatches',
        Number(dryRun.counts?.flagMismatches ?? 0) === 0,
        `dry-run flag mismatches=${dryRun.counts?.flagMismatches ?? 'unknown'}`
      )
    );
    checks.push(
      createCheck(
        'dry_run.matches_live',
        areCountsEqual(dryRun.counts, liveCounts, LIVE_COUNT_KEYS),
        areCountsEqual(dryRun.counts, liveCounts, LIVE_COUNT_KEYS)
          ? 'latest live analysis matches dry-run counts'
          : 'latest live analysis does not match dry-run counts'
      )
    );
  }

  checks.push(
    createCheck(
      'artifact.snapshot',
      Boolean(snapshot),
      snapshot
        ? `snapshot report ready: ${artifacts.snapshot.preferred.path}`
        : describeMissingArtifact(
            artifacts.snapshot.latestAny ? [artifacts.snapshot.latestAny] : [],
            'snapshot'
          )
    )
  );

  if (snapshot) {
    const snapshotPath = snapshot.snapshot?.snapshotPath ?? null;
    const snapshotRecords = snapshot.snapshot?.snapshotRecords ?? null;

    const snapshotFileOk =
      snapshotRecords === 0
        ? true // no candidates → no backup file needed
        : Boolean(snapshotPath) && fs.existsSync(snapshotPath);
    checks.push(
      createCheck(
        'snapshot.backup_file',
        snapshotFileOk,
        snapshotRecords === 0
          ? 'no migration candidates — snapshot backup not required'
          : snapshotPath
            ? `snapshot backup exists: ${snapshotPath}`
            : 'snapshot report does not contain snapshotPath'
      )
    );
    checks.push(
      createCheck(
        'snapshot.matches_live_candidates',
        snapshotRecords === liveCounts.toMigrate,
        `snapshot records=${snapshotRecords ?? 'unknown'}, live candidates=${liveCounts.toMigrate}`
      )
    );
  }

  checks.push(
    createCheck(
      'artifact.rehearsal',
      Boolean(rehearsal),
      rehearsal
        ? `rehearsal report ready: ${artifacts.rehearsal.preferred.path}`
        : describeMissingArtifact(
            artifacts.rehearsal.latestAny ? [artifacts.rehearsal.latestAny] : [],
            'rehearsal'
          )
    )
  );

  if (rehearsal) {
    checks.push(
      createCheck(
        'rehearsal.rolled_back',
        rehearsal.rehearsal?.rehearsalRolledBack === true,
        rehearsal.rehearsal?.rehearsalRolledBack === true
          ? 'AES rehearsal completed and rolled back'
          : 'AES rehearsal report does not prove rollback'
      )
    );
    checks.push(
      createCheck(
        'rehearsal.matches_live_candidates',
        rehearsal.rehearsal?.candidateCount === liveCounts.toMigrate &&
          rehearsal.rehearsal?.migratedCount === liveCounts.toMigrate &&
          rehearsal.rehearsal?.rolledBackCount === liveCounts.toMigrate,
        `rehearsal candidateCount=${rehearsal.rehearsal?.candidateCount ?? 'unknown'}, live candidates=${liveCounts.toMigrate}`
      )
    );
  }

  checks.push(
    createCheck(
      'artifact.restore_rehearsal',
      Boolean(restoreRehearsal),
      restoreRehearsal
        ? `restore rehearsal report ready: ${artifacts.restoreRehearsal.preferred.path}`
        : 'missing restore rehearsal artifact'
    )
  );

  if (restoreRehearsal) {
    const restoreResult = restoreRehearsal.result ?? {};
    const stableCounts =
      areCountsEqual(restoreResult.backupCounts, restoreResult.liveCountsBefore, RESTORE_COUNT_KEYS) &&
      areCountsEqual(
        restoreResult.backupCounts,
        restoreResult.restoredCountsInTransaction,
        RESTORE_COUNT_KEYS
      );

    checks.push(
      createCheck(
        'restore_rehearsal.rolled_back',
        restoreResult.rehearsalRolledBack === true,
        restoreResult.rehearsalRolledBack === true
          ? 'restore rehearsal completed and rolled back'
          : 'restore rehearsal report does not prove rollback'
      )
    );
    checks.push(
      createCheck(
        'restore_rehearsal.counts_stable',
        stableCounts,
        stableCounts
          ? 'restore rehearsal backup/live/restored counts are consistent'
          : 'restore rehearsal backup/live/restored counts drifted'
      )
    );
  }

  const latestWarnings = [
    ['dry-run', artifacts.dryRun],
    ['snapshot', artifacts.snapshot],
    ['rehearsal', artifacts.rehearsal]
  ];

  for (const [label, selection] of latestWarnings) {
    if (
      selection.latestAny &&
      selection.preferred &&
      selection.latestAny.path !== selection.preferred.path
    ) {
      warnings.push(
        `latest ${label} artifact is filtered or unusable; readiness gate selected the most recent full-scope artifact instead (${selection.preferred.path}).`
      );
    }
  }

  const failures = checks.filter((check) => !check.ok).map((check) => check.detail);

  return {
    generatedAt: new Date().toISOString(),
    ready: failures.length === 0,
    nextAction:
      failures.length === 0
        ? 'Gate passed. Execute USE_AES_ENCRYPTION=true ENCRYPTION_KEY=*** ENCRYPTION_SALT=*** AES_MIGRATION_OPERATOR=... npm run aes:migrate -- --allow-remote when operator window is open.'
        : failures[0],
    liveCounts,
    environment: {
      encryptionKeyConfigured: env.encryptionKeyConfigured,
      encryptionSaltConfigured: env.encryptionSaltConfigured,
      useAesEncryption: env.useAesEncryption
    },
    artifacts: {
      dryRun: summarizeArtifact(artifacts.dryRun.preferred),
      latestDryRunSeen: summarizeArtifact(artifacts.dryRun.latestAny),
      snapshot: summarizeArtifact(artifacts.snapshot.preferred),
      latestSnapshotSeen: summarizeArtifact(artifacts.snapshot.latestAny),
      rehearsal: summarizeArtifact(artifacts.rehearsal.preferred),
      latestRehearsalSeen: summarizeArtifact(artifacts.rehearsal.latestAny),
      restoreRehearsal: summarizeArtifact(artifacts.restoreRehearsal.preferred)
    },
    checks,
    warnings,
    failures
  };
}
