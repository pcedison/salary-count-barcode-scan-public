# Changelog

All notable changes to `barcode_scan_V3` will be documented in this file.

This repository follows Keep a Changelog style and uses the clean-room public history as its bootstrap baseline.

## [Unreleased]

- No unreleased notes yet.

## [2.1.8] - 2026-04-15

### Fixed

- `client/src/lib/mainTabPreload.ts` now absorbs lazy-route preload failures so idle and hover prefetching does not raise unhandled promise rejections during transient chunk-load errors.

## [2.1.7] - 2026-04-15

### Fixed

- `POST /api/verify-admin` now accepts a valid super admin PIN and creates a SUPER session directly, so operators can log in with either the standard admin PIN or the super admin PIN from the first prompt.
- Admin login messaging now makes it clear that the shared PIN dialog accepts either a standard admin PIN or a super admin PIN.

## [2.1.6] - 2026-04-15

### Changed

- Main navigation now preloads non-active app sections during browser idle time and warms the next tab on hover/focus, so switching into the Settings page feels faster on first open.

### Added

- `client/src/lib/mainTabPreload.ts` centralizes lazy-route preloading so the main tabs can share the same idle/hover preload strategy.

## [2.1.5] - 2026-04-14

### Changed

- The attendance page now treats the public `/api/attendance/today` lock gate as a waiting state instead of showing a misleading perpetual "syncing" badge.

### Fixed

- The attendance sync badge now distinguishes between `資料已同步`, `同步中...`, `等待解鎖`, and `同步失敗`, so a locked kiosk no longer looks like an active sync that never finishes.

## [2.1.4] - 2026-04-14

### Changed

- Expected 401 responses for the locked kiosk attendance endpoint and anonymous operational metrics probe now log at `info` level instead of `warn`.
- The ad-hoc live Playwright smoke script now validates the public QR code route against its admin gate and uses more stable UI locators.

### Fixed

- `useSettings()` now memoizes resolved settings payloads so the Settings page no longer reinitializes form state on every render and triggers the React "Maximum update depth exceeded" warning.

## [2.1.3] - 2026-04-13

### Added

- `npm run smoke:live` for reusable Zeabur/public deployment smoke checks with JSON report output under `tmp/`.

### Changed

- `docs/OPERATIONS_RUNBOOK.md` now documents the live smoke command for operator-side canary checks.

### Fixed

- `/api/health` now reports the packaged application version in production instead of falling back to `0.0.0` after server bundling.

## [2.1.2] - 2026-04-13

### Added

- Public governance and contribution docs through `SECURITY.md`, `CONTRIBUTING.md`, issue templates, and a pull request template.
- `docs/ARCHITECTURE.md` and `docs/SUPPORT_POLICY.md` for faster public onboarding and clearer maintainer boundaries.

### Changed

- `README.md` now clarifies who the project is for and links directly to the new governance and support docs.
- `docs/PUBLIC_REPO_HARDENING_PLAN.md` now reflects the repo work completed in this branch and highlights the remaining external controls.
- `scripts/version-auto.mjs` now treats governance-only updates as patch releases so documentation work does not inflate application version numbers.

## [2.1.1] - 2026-04-13

### Added

- Clean-room public release snapshot for the sanitized repository.
- Production-safe `SUPER_ADMIN_PIN` hashing helper and documentation.

### Changed

- Footer and version metadata now derive from the tracked application version instead of a hard-coded display string.
- Docker runtime defaults now match the smoke-test port expectations.
- LINE API calls now use explicit timeouts to avoid platform-level request hangs.

### Fixed

- Recycle-bin purge lookup now resolves soft-deleted employees correctly.

## Notes

- Earlier clean-room history entries are preserved in git commit history and summarized above as part of the bootstrap release line.
- Future entries should prefer concise release notes grouped by `Added`, `Changed`, `Fixed`, `Security`, and `Deprecated` when needed.
