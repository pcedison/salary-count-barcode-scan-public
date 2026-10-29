import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCloudRunMode, usesStdoutAudit } from './runtimeMode';

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

type CloudMountEvidence = {
  mountInfo: string;
  metadata: unknown;
  realPath: (value: string) => string;
};

// Evidence is injected only by unit tests. Production always reads kernel mount
// information and the operator-provisioned bucket marker; an env flag is not proof.
export function assertCloudRuntimeStorage(evidence?: CloudMountEvidence): void {
  if (!isCloudRunMode()) return;
  const root = process.env.APP_STORAGE_MOUNT?.trim();
  const bucket = process.env.APP_STORAGE_BUCKET?.trim();
  const runtime = process.env.APP_RUNTIME_DIR?.trim();
  const backup = process.env.APP_BACKUP_DIR?.trim();
  if (!root || !bucket || !runtime || !backup || ![root, runtime, backup].every(path.isAbsolute)) {
    throw new Error('Cloud Run requires explicit absolute storage mount, runtime and backup paths plus bucket identity');
  }
  if (root === path.parse(root).root || !usesStdoutAudit()) {
    throw new Error('Cloud Run requires a dedicated storage mount and APP_AUDIT_SINK=stdout');
  }
  let actual: CloudMountEvidence;
  try {
    actual = evidence ?? {
      mountInfo: fs.readFileSync('/proc/self/mountinfo', 'utf8'),
      metadata: JSON.parse(fs.readFileSync(path.join(root, '.attendance-volume.json'), 'utf8')),
      realPath: value => fs.realpathSync(value),
    };
    const resolvedRoot = actual.realPath(root);
    for (const target of [runtime, backup]) {
      if (!isSameOrNestedPath(resolvedRoot, actual.realPath(target))) throw new Error('path escaped mount');
    }
    if (isSameOrNestedPath(process.cwd(), resolvedRoot)) throw new Error('mount inside workspace');
    const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const mount = actual.mountInfo.split('\n').find(line => {
      const [fields, filesystem] = line.split(' - ');
      const parts = fields?.split(' ');
      return parts?.[4] && decode(parts[4]) === resolvedRoot
        && parts[5].split(',').includes('rw')
        && filesystem?.split(' ')[0] === 'fuse.gcsfuse';
    });
    const metadata = actual.metadata as Record<string, unknown> | null;
    if (!mount || metadata?.format !== 'attendance-runtime-v1' || metadata.bucket !== bucket) throw new Error('unverified mount');
  } catch {
    throw new Error('Cloud Run persistent storage could not be verified; require a writable GCS FUSE mount, matching bucket marker and existing runtime directories');
  }
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
    ...(usesStdoutAudit() ? [] : [ensureDirectory(summary.auditLogDir)])
  ]);
}
