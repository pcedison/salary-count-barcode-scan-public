import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAppVersion,
  resetAppVersionCacheForTest,
  resolvePackageJsonPathCandidates
} from "./appVersion";

afterEach(() => {
  resetAppVersionCacheForTest();
});

describe("appVersion", () => {
  it("prefers APP_VERSION when it is provided", () => {
    const version = getAppVersion({
      env: {
        APP_VERSION: "2.1.2",
        npm_package_version: "1.0.0"
      } as NodeJS.ProcessEnv
    });

    expect(version).toBe("2.1.2");
  });

  it("includes a one-level-up package.json candidate for bundled dist output", () => {
    const candidates = resolvePackageJsonPathCandidates("file:///app/dist/index.js");

    expect(candidates).toContain("/app/package.json");
  });

  it("reads package.json successfully from a bundled dist layout", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "app-version-"));
    const distDir = path.join(tempRoot, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ version: "9.8.7" }, null, 2)
    );

    const version = getAppVersion({
      env: {} as NodeJS.ProcessEnv,
      moduleUrl: new URL(`file://${path.join(distDir, "index.js")}`).href
    });

    expect(version).toBe("9.8.7");
  });
});
