# Public Repo Hardening Plan

Audit target:

- Repo: `pcedison/salary-count-barcode-scan-public`
- Branch: `main`
- Baseline commit: `b2a60c49487b8d009e8adc60ec7bd16207727824`
- Plan date: `2026-04-13`

## Goal

Strengthen the public repository so it is easier to operate safely, easier for external contributors to understand, and easier to maintain without losing the clean-room public-release posture.

This plan assumes the current clean-room repository already passes the basic public-release gates for:

- current-tree secret hygiene
- short clean-room git history
- dependency audit
- release verification

The remaining work focuses on public-project maturity and governance.

## Current Baseline

Already in place:

- public clean-room repository history
- `LICENSE`
- release verification commands and CI
- public-release checklist, deployment guide, and operations runbooks
- runtime env validation, session guardrails, and production secret requirements

Still missing or needing improvement:

- lightweight automated public-release hygiene scan
- branch-protection enforcement in GitHub settings
- explicit release ownership and canary confirmation outside the repo

## Execution Phases

### P0: Immediate public-governance baseline

Status: `Baseline landed in repo; external controls still pending`

Completed in this branch:

- `SECURITY.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `README.md` links to the governance docs and clarifies intended audience
- `docs/ARCHITECTURE.md`
- `docs/SUPPORT_POLICY.md`

Still pending outside the repo:

- enable branch protection on `main`
- require `required-checks` and `docker-smoke`
- complete operator-side canary validation on the live deployment

Definition of done:

- external users know how to report vulnerabilities
- contributors know how to set up, test, and submit changes
- GitHub issue/PR flows nudge contributors toward the repo's existing release and security rules

### P1: Release communication and onboarding

Status: `Completed in this branch`

- tighten README audience/fit guidance
- add a simple public architecture doc or diagram
- document versioning workflow for maintainers
- add a public support / maintenance policy

Definition of done:

- maintainers can explain what changed between releases
- new adopters can understand the major moving parts without reading the whole codebase
- support expectations are clear before operators deploy

### P2: Operational maturity

Status: `Planned`

- automate lightweight public-release hygiene checks
- document support policy / maintenance scope
- review branch protection and required checks in GitHub settings
- formalize release checklist ownership

Definition of done:

- public maintenance expectations are explicit
- release cadence and repository governance are repeatable

## Prioritized Work Queue

1. lightweight automated public-release hygiene scan
2. branch-protection and release-ownership confirmation outside the repo
3. canary sign-off against the live deployment
4. periodic review of README and architecture docs as features change

## Notes For Maintainers

- Treat `package.json` version as the application version source of truth.
- Use `npm run version:preview` before release preparation to inspect the suggested bump.
- Use `npm run version:auto` only after reviewing whether the detected change impact matches the intended release scope.
- Keep public repo docs free of internal hostnames, workstation paths, operator-only handoff notes, and real credentials.

## Verification After This Plan Lands

Run:

```bash
npm run verify:release
git diff --check
```

Operator follow-up outside the repo:

- keep Zeabur / deployment secrets rotated
- keep LINE callback and LIFF endpoint URLs aligned with the live public domain
- enforce branch protection for `main`
