import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const FALLBACK_VERSION = "0.0.0";

let cachedVersion: string | null = null;

function resolveCandidateVersion(version: string | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed : null;
}

export function resolvePackageJsonPathCandidates(moduleUrl = import.meta.url): string[] {
  const currentDir = path.dirname(fileURLToPath(moduleUrl));

  return Array.from(
    new Set([
      path.resolve(currentDir, "../../package.json"),
      path.resolve(currentDir, "../package.json"),
      path.resolve(process.cwd(), "package.json")
    ])
  );
}

type GetAppVersionOptions = {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
};

export function resetAppVersionCacheForTest(): void {
  cachedVersion = null;
}

export function getAppVersion(options: GetAppVersionOptions = {}): string {
  const env = options.env ?? process.env;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const shouldUseCache = env === process.env && moduleUrl === import.meta.url;

  if (shouldUseCache && cachedVersion) {
    return cachedVersion;
  }

  const envVersion =
    resolveCandidateVersion(env.APP_VERSION) ||
    resolveCandidateVersion(env.npm_package_version);

  if (envVersion) {
    if (shouldUseCache) {
      cachedVersion = envVersion;
    }

    return envVersion;
  }

  for (const packageJsonPath of resolvePackageJsonPathCandidates(moduleUrl)) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf8")
      ) as { version?: string };
      const version = resolveCandidateVersion(packageJson.version);

      if (!version) {
        continue;
      }

      if (shouldUseCache) {
        cachedVersion = version;
      }

      return version;
    } catch {
      // Try the next candidate path.
    }
  }

  if (shouldUseCache) {
    cachedVersion = FALLBACK_VERSION;
  }

  return FALLBACK_VERSION;
}
