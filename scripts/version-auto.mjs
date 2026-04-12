import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");
const PACKAGE_LOCK_PATH = path.join(ROOT_DIR, "package-lock.json");
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const IMPACT_LEVELS = new Set(["patch", "minor", "major"]);
const DOC_PATH_PATTERN = /^(docs\/|\.github\/|README\.md$|API_DOCUMENTATION\.md$|DATABASE_SCHEMA\.md$|SECURITY\.md$|CONTRIBUTING\.md$|CHANGELOG\.md$)/;
const GOVERNANCE_TOOLING_PATH_PATTERN = /^scripts\/version-auto\.mjs$/;
const TEST_PATH_PATTERN = /(\.test\.[cm]?[jt]sx?$|\.integration\.test\.[cm]?[jt]sx?$)/;
const ARCHITECTURE_PATH_PATTERNS = [
  /^server\/bootstrap\//,
  /^server\/config\//,
  /^server\/db\.ts$/,
  /^server\/session\.ts$/,
  /^server\/storage\.ts$/,
  /^server\/repositories\//,
  /^server\/middleware\/security\.ts$/,
  /^server\/routes\/line\//,
  /^shared\/schema\.ts$/,
  /^vite\.config\.ts$/,
  /^Dockerfile$/,
  /^package(-lock)?\.json$/,
  /^\.github\/workflows\//
];

function runGit(args) {
  return execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8"
  }).trim();
}

function parseArgs(argv) {
  const options = {
    apply: false,
    impact: null,
    from: null,
    to: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--impact") {
      options.impact = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--from") {
      options.from = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--to") {
      options.to = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
  }

  if (options.impact && !IMPACT_LEVELS.has(options.impact)) {
    throw new Error(`Unsupported impact level: ${options.impact}`);
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`package.json version must be x.y.z, received: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(currentVersion, impact) {
  const parsed = parseVersion(currentVersion);

  switch (impact) {
    case "major":
      return formatVersion({
        major: parsed.major + 1,
        minor: 1,
        patch: 1
      });
    case "minor":
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 1
      });
    case "patch":
    default:
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1
      });
  }
}

function hasHeadCommit() {
  try {
    runGit(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function resolveDiffRange(options) {
  if (options.from) {
    return { from: options.from, to: options.to ?? "HEAD" };
  }

  if (!hasHeadCommit()) {
    return { from: EMPTY_TREE_SHA, to: "HEAD" };
  }

  const isDirty = runGit(["status", "--porcelain"]).length > 0;
  if (isDirty) {
    return { from: "HEAD", to: null };
  }

  try {
    runGit(["rev-parse", "--verify", "HEAD^"]);
    return { from: "HEAD^", to: "HEAD" };
  } catch {
    return { from: EMPTY_TREE_SHA, to: "HEAD" };
  }
}

function getUntrackedFiles() {
  const output = runGit(["ls-files", "--others", "--exclude-standard"]);
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((filePath) => ({
      path: filePath,
      insertions: countFileLines(path.join(ROOT_DIR, filePath)),
      deletions: 0
    }));
}

function countFileLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const matches = content.match(/\n/g);
    return (matches?.length ?? 0) + 1;
  } catch {
    return 1;
  }
}

function getDiffFiles(range) {
  const args = ["diff", "--numstat", "--find-renames", range.from];
  if (range.to) {
    args.push(range.to);
  }

  const output = runGit(args);
  const files = output
    ? output.split("\n").filter(Boolean).map((line) => {
        const [insertions, deletions, ...pathParts] = line.split("\t");
        return {
          path: pathParts.join("\t"),
          insertions: Number(insertions) || 0,
          deletions: Number(deletions) || 0
        };
      })
    : [];

  if (!range.to) {
    files.push(...getUntrackedFiles());
  }

  return files;
}

function topLevelArea(filePath) {
  const [head, next] = filePath.split("/");

  if (!next) {
    return head;
  }

  if (head === "server" || head === "client" || head === "shared") {
    return `${head}/${next}`;
  }

  return head;
}

function classifyImpact(files) {
  if (files.length === 0) {
    return {
      impact: "patch",
      reasons: ["No tracked file changes detected; defaulting to patch."]
    };
  }

  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const totalLineChanges = insertions + deletions;
  const areas = new Set(files.map((file) => topLevelArea(file.path)));
  const runtimeAreas = new Set(
    files
      .map((file) => file.path.split("/")[0])
      .filter((segment) => ["client", "server", "shared", "scripts"].includes(segment))
  );
  const docsOnly = files.every((file) => DOC_PATH_PATTERN.test(file.path) || GOVERNANCE_TOOLING_PATH_PATTERN.test(file.path));
  const testOnly = files.every(
    (file) =>
      TEST_PATH_PATTERN.test(file.path) ||
      DOC_PATH_PATTERN.test(file.path) ||
      GOVERNANCE_TOOLING_PATH_PATTERN.test(file.path)
  );
  const touchesArchitecture = files.some((file) =>
    ARCHITECTURE_PATH_PATTERNS.some((pattern) => pattern.test(file.path))
  );
  const reasons = [
    `${files.length} files changed, ${insertions} insertions, ${deletions} deletions.`,
    `Touched areas: ${Array.from(areas).join(", ")}.`
  ];

  if (docsOnly || testOnly) {
    reasons.push("Changes are documentation/test scoped.");
    return { impact: "patch", reasons };
  }

  if (
    totalLineChanges >= 400 ||
    files.length >= 14 ||
    runtimeAreas.size >= 4 ||
    (touchesArchitecture && totalLineChanges >= 120)
  ) {
    reasons.push("Change spans architecture or multiple runtime surfaces; treating as major.");
    return { impact: "major", reasons };
  }

  if (
    touchesArchitecture ||
    totalLineChanges >= 90 ||
    files.length >= 5 ||
    runtimeAreas.size >= 2
  ) {
    reasons.push("Change is broader than a micro-fix; treating as minor.");
    return { impact: "minor", reasons };
  }

  reasons.push("Change is contained and low-risk; treating as patch.");
  return { impact: "patch", reasons };
}

function updatePackageVersion(nextVersion) {
  const packageJson = readJson(PACKAGE_JSON_PATH);
  packageJson.version = nextVersion;
  writeJson(PACKAGE_JSON_PATH, packageJson);

  const packageLock = readJson(PACKAGE_LOCK_PATH);
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  writeJson(PACKAGE_LOCK_PATH, packageLock);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = readJson(PACKAGE_JSON_PATH);
  const currentVersion = packageJson.version;
  const range = resolveDiffRange(options);
  const files = getDiffFiles(range);
  const classification = options.impact
    ? {
        impact: options.impact,
        reasons: [`Impact explicitly overridden to ${options.impact}.`]
      }
    : classifyImpact(files);
  const nextVersion = bumpVersion(currentVersion, classification.impact);

  console.log(`Current version: ${currentVersion}`);
  console.log(`Recommended impact: ${classification.impact}`);
  console.log(`Next version: ${nextVersion}`);
  for (const reason of classification.reasons) {
    console.log(`- ${reason}`);
  }

  if (!options.apply) {
    console.log("");
    console.log("Run with --apply to write package.json and package-lock.json.");
    return;
  }

  updatePackageVersion(nextVersion);
  console.log("");
  console.log(`Updated package.json and package-lock.json to ${nextVersion}.`);
}

main();
