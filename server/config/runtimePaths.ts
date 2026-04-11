import fs from 'fs';
import os from 'os';
import path from 'path';

const APP_RUNTIME_NAMESPACE = 'barcode_scan_V3';
const DIRECTORY_MODE = 0o700;

function normalizeForComparison(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrNestedPath(parentPath: string, childPath: string): boolean {
  const normalizedParent = normalizeForComparison(parentPath);
  const normalizedChild = normalizeForComparison(childPath);

  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
  );
}

function resolveDefaultRuntimeRoot(): string {
  const configuredRuntimeDir = process.env.APP_RUNTIME_DIR?.trim();
  if (configuredRuntimeDir) {
    return path.resolve(configuredRuntimeDir);
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (process.platform === 'win32' && localAppData) {
    return path.resolve(localAppData, APP_RUNTIME_NAMESPACE);
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    return path.resolve(xdgStateHome, APP_RUNTIME_NAMESPACE);
  }

  const homeDirectory = os.homedir();
  if (homeDirectory) {
    return process.platform === 'win32'
      ? path.resolve(homeDirectory, 'AppData', 'Local', APP_RUNTIME_NAMESPACE)
      : path.resolve(homeDirectory, '.local', 'state', APP_RUNTIME_NAMESPACE);
  }

  return path.resolve(os.tmpdir(), APP_RUNTIME_NAMESPACE);
}

export type RuntimePathSummary = {
  workspaceRootDir: string;
  runtimeRootDir: string;
  backupRootDir: string;
  auditLogDir: string;
  insideWorkspace: {
    runtimeRootDir: boolean;
    backupRootDir: boolean;
    auditLogDir: boolean;
  };
};

export function getRuntimePathSummary(): RuntimePathSummary {
  const workspaceRootDir = path.resolve(process.cwd());
  const runtimeRootDir = resolveDefaultRuntimeRoot();
  const backupRootDir = path.resolve(
    process.env.APP_BACKUP_DIR?.trim() || path.join(runtimeRootDir, 'backups')
  );
  const auditLogDir = path.resolve(
    process.env.APP_LOG_DIR?.trim() || path.join(runtimeRootDir, 'logs')
  );

  return {
    workspaceRootDir,
    runtimeRootDir,
    backupRootDir,
    auditLogDir,
    insideWorkspace: {
      runtimeRootDir: isSameOrNestedPath(workspaceRootDir, runtimeRootDir),
      backupRootDir: isSameOrNestedPath(workspaceRootDir, backupRootDir),
      auditLogDir: isSameOrNestedPath(workspaceRootDir, auditLogDir)
    }
  };
}

export function getBackupRootDir(): string {
  return getRuntimePathSummary().backupRootDir;
}

export function getAuditLogDir(): string {
  return getRuntimePathSummary().auditLogDir;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return;
  }

  await fs.promises.mkdir(dirPath, { recursive: true, mode: DIRECTORY_MODE });
}

export async function ensureBackupRootDirExists(): Promise<void> {
  await ensureDirectory(getBackupRootDir());
}

export async function ensureAuditLogDirExists(): Promise<void> {
  await ensureDirectory(getAuditLogDir());
}

export async function ensureRuntimeDirectoriesExist(): Promise<void> {
  const summary = getRuntimePathSummary();
  await Promise.all([
    ensureDirectory(summary.runtimeRootDir),
    ensureDirectory(summary.backupRootDir),
    ensureDirectory(summary.auditLogDir)
  ]);
}
