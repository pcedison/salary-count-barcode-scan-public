import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const FALLBACK_VERSION = "0.0.0";

let cachedVersion: string | null = null;

function resolvePackageJsonPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../package.json");
}

export function getAppVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const npmVersion = process.env.npm_package_version?.trim();
  if (npmVersion) {
    cachedVersion = npmVersion;
    return cachedVersion;
  }

  try {
    const packageJson = JSON.parse(
      fs.readFileSync(resolvePackageJsonPath(), "utf8")
    ) as { version?: string };
    const version = packageJson.version?.trim();

    if (version) {
      cachedVersion = version;
      return cachedVersion;
    }
  } catch {
    // Fall through to the static fallback when package metadata is unavailable.
  }

  cachedVersion = FALLBACK_VERSION;
  return cachedVersion;
}
