# Dependency And Runtime Update Policy

This project treats dependency updates and runtime updates as release work, not as background noise.

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
- Deploy during a normal release window.

Major dependency updates:

- Use a local branch first.
- Read the package migration notes.
- Update tests or code intentionally.
- Run `npm run verify:release`.
- Run any affected manual smoke checks before pushing the branch.

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

Do not update the Zeabur production runtime before the repository contract is updated, tested, reviewed, and merged.

The safe order is:

1. detect update signal
2. create local branch
3. update runtime/dependency contract
4. run local verification
5. push branch and open PR
6. wait for GitHub checks
7. merge
8. deploy to Zeabur
9. run live smoke checks

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
