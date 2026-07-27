# Dependency And Runtime Update Policy

This project treats dependency updates and runtime updates as release work, not as
background noise.

## Automated Update Boundaries

Scheduled npm version updates are limited to SemVer minor and patch releases. Dependabot
groups the React runtime and type packages together before applying the catch-all npm
minor-and-patch group:

- `react`
- `react-dom`
- `@types/react`
- `@types/react-dom`

This keeps compatible React runtime and type updates in one pull request. All other
npm minor and patch updates remain eligible for the catch-all group.

The npm `allow.update-types` restriction applies only to scheduled version updates.
When Dependabot security updates are enabled, GitHub continues to create their pull
requests regardless of that SemVer restriction. Docker and GitHub Actions continue
to use their weekly version-update schedules.

## Dependabot Auto-Merge

Only Dependabot-authored events for pull requests whose metadata reports a SemVer
minor or patch update are enrolled in GitHub squash auto-merge. Auto-merge never
bypasses repository rules: the pull request must target `main`, come from a
same-repository `dependabot/` branch, remain non-draft, match the verified head commit,
be conflict-free, and pass the protected `required-checks` and `docker-smoke` jobs
as well as `Mobile UI structural checks` before GitHub merges it.

On every eligible pull-request event, the workflow first clears any prior auto-merge
request. It only re-enables auto-merge when Dependabot itself triggered the event and
verified metadata reports a minor or patch update. Maintainer-modified pull requests,
major updates, metadata failures, and unknown or non-SemVer update types remain manual
and receive an Actions notice.

This auto-merge boundary applies equally to version and security update pull requests:
a minor or patch security update may auto-merge after all safeguards pass, while a
major security update requires manual review and migration.

The repository's `main` branch is connected to the production Zeabur service. A merge
to `main` can therefore trigger a production deployment automatically and must be
treated as release authorization. Protected checks are pre-deployment gates; after
Zeabur reports the deployed SHA as successful, run the live smoke checks and monitor
the canary signals below.

## Alert Sources

Automated update signals:

- Dependabot version updates for npm packages, Docker base images, and GitHub Actions.
- Dependabot security updates from GitHub repository security settings.
- `npm run runtime:update:audit` for the Node.js runtime contract.

Manual operator signals:

- Zeabur build/runtime deprecation notices.
- GitHub Actions runner or action deprecation notices.
- Node.js LTS and EOL announcements.
- npm major release notes when the project package manager changes.

## Update Lanes

Security updates:

- Open or accept the Dependabot PR.
- Run `npm run verify:release`.
- Review production impact and merge through the normal PR path.
- Deploy only after the protected GitHub checks are green.

Minor and patch dependency updates:

- Review weekly.
- Prefer grouped Dependabot PRs unless a package has operational risk.
- Run `npm run verify:release`.
- Run `npm run runtime:update:audit` when the update can affect the Node.js contract.
- Treat the scheduled Dependabot window as a production release window. After an
  automatic merge, confirm the Zeabur deployment SHA and run the live smoke checks.

Major dependency updates:

- Scheduled npm major version pull requests are not created automatically. Open a
  dedicated migration branch and pull request when the project is ready.
- A major security, Docker, or GitHub Actions pull request may still be created by
  GitHub, but it is not eligible for auto-merge.
- Read the upstream release and migration notes before changing the dependency.
- Update tightly coupled packages and configuration in the same migration. For
  example, keep React runtime and type packages aligned, migrate Tailwind plugins and
  PostCSS configuration together, and remove obsolete TypeScript compiler options.
- Run `npm ci`, `npm run verify:release`, and all affected manual smoke checks before
  requesting review.
- Require a maintainer to review the migration and protected checks before merging.
- If a staging environment is available, deploy and smoke-test the migration there
  before merging to the production-connected `main` branch.

Runtime updates:

- Create a local branch before changing the runtime contract.
- Update all runtime contract files together:
  - `package.json` `engines.node`
  - `package.json` `engines.npm`
  - `package.json` `packageManager`
  - `package-lock.json`
  - `Dockerfile` builder and runtime images
  - `.github/workflows/ci.yml` `node-version`
  - `scripts/build-server.mjs` esbuild target
  - `@types/node`
  - deployment and operations docs
- Run:

```bash
npm ci
npm run runtime:update:audit
npm run verify:release
docker build -t barcode-scan-runtime-audit .
```

The current production runtime target is Node.js `24.16.0` with npm `11.13.0`.
Docker and Zeabur deployments should use the repository Dockerfile or an equivalent Node 24 LTS runtime.

- If the deployment target has a staging or preview environment, deploy there first.
- Run live smoke checks against staging before updating Zeabur production.

## Zeabur Deployment Rule

Do not update the Zeabur production runtime before the repository contract is updated,
tested, and reviewed. Because merges to `main` can deploy automatically, complete any
available staging validation before merge.

The safe order is:

1. detect update signal
2. create local branch
3. update runtime/dependency contract
4. run local verification
5. push branch and open PR
6. wait for GitHub checks
7. deploy to staging and run smoke checks, when staging is available
8. merge to `main`, authorizing the automatic production deployment
9. confirm the Zeabur production deployment SHA and status
10. run live smoke checks and monitor the canary

## Weekly Operator Checklist

Run:

```bash
npm run runtime:update:audit
npm outdated
npm audit --omit=dev
```

Then check:

- open Dependabot PRs
- open security alerts
- GitHub Actions deprecation notices
- Zeabur runtime or build image notices
- Node.js LTS/EOL status

Record any required runtime migration as an issue or PR before changing production.
