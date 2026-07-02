# Zeabur Stability Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four production stability gaps and drive Zeabur `1/1181` from a confusing abnormal-restart display into an evidence-backed resolved or platform-support path.

**Architecture:** Split the work into code deployment, platform configuration, device integration, and operational verification. Code changes must land through GitHub and Zeabur must deploy a known commit SHA; platform-only changes must be recorded without exposing secrets.

**Tech Stack:** Node.js 24.x, npm 11.x, Express, React/Vite, PostgreSQL, Zeabur, GitHub, Vitest.

## Global Constraints

- Use Traditional Chinese for operator-facing notes.
- Do not print secrets, tokens, cookies, passwords, full database URLs, or full authorization headers.
- Production deployment must distinguish local commit, GitHub branch or PR, CI status, and Zeabur deployment SHA.
- Production must use platform variables, not a workspace `.env`.
- Zeabur should build the repo-root `Dockerfile`.
- Run `npm run check`, `npm test`, and `npm run build` before merging code to production.
- Run live health checks and `npm run smoke:live -- --base-url https://barcode-scan.zeabur.app` after deployment.
- Do not use `git reset --hard`, `git checkout --`, or force-overwrite user changes.

---

## Current Evidence Snapshot

- Local repo: `C:\Users\y_mea\Desktop\barcode_scan_V3_public_clean`
- Git remote: `https://github.com/pcedison/salary-count-barcode-scan-public.git`
- Current local branch: `codex/zeabur-graceful-shutdown`
- Local fix commit waiting to be published: `e0fa69d fix: handle graceful shutdown on deploy`
- GitHub `main` observed locally: `be9e589672a0cbbc3b35cce93ffa49ecff7d0e84`
- Production URL: `https://barcode-scan.zeabur.app`
- Health check at 2026-06-29 14:02 Asia/Taipei: `/api/health` healthy, `/ready` true, `/live` true, RSS about 376 MB, heap about 10% of V8 limit.
- Zeabur UI symptom from screenshots: one running pod plus many old pods marked abnormal restart, shown as `1/1181`.

## Files And Ownership

- Modify already completed locally: `server/bootstrap/graceful-shutdown.ts`
  - Owns SIGTERM/SIGINT handling and clean server shutdown.
- Modify already completed locally: `server/bootstrap/graceful-shutdown.test.ts`
  - Owns regression coverage for clean exit and failed shutdown paths.
- Modify already completed locally: `server/index.ts`
  - Wires graceful shutdown into the production server lifecycle.
- Optional create: `docs/operations/zeabur-stability-log.md`
  - Operator evidence log for deployment SHA, health checks, Zeabur pod display, and support-ticket status.
- Platform-only: Zeabur Variables
  - Owns `APP_RUNTIME_DIR`, `APP_BACKUP_DIR`, `APP_LOG_DIR`, `SCAN_DEVICE_TOKEN`, and removal or mitigation of `DEFAULT_ADMIN_PIN`.
- Platform-only: Zeabur Hard Disk settings
  - Owns the persistent mount path used by runtime directories.
- External device-only: Raspberry Pi or scanner client config
  - Owns the same device token value as Zeabur `SCAN_DEVICE_TOKEN`.

---

### Task 1: Ship Graceful Shutdown Fix To Production

**Files:**
- Already modified: `server/bootstrap/graceful-shutdown.ts`
- Already modified: `server/bootstrap/graceful-shutdown.test.ts`
- Already modified: `server/index.ts`
- Optional create: `docs/operations/zeabur-stability-log.md`

**Interfaces:**
- Consumes: Node `SIGTERM` and `SIGINT` events from Zeabur/Kubernetes rollout.
- Produces: clean runtime service shutdown, `server.close()`, and `process.exit(0)` on expected deploy termination.

- [ ] **Step 1: Confirm local diff scope**

Run:

```powershell
git status --short --branch
git diff --stat main..HEAD
git diff -- server/bootstrap/graceful-shutdown.ts server/bootstrap/graceful-shutdown.test.ts server/index.ts
```

Expected:

```text
Only graceful-shutdown files and server/index.ts are different from main.
No unrelated user edits are staged.
```

- [ ] **Step 2: Re-run release verification before publishing**

Run:

```powershell
npm run check
npm test
npm run build
```

Expected:

```text
All commands exit 0.
```

- [ ] **Step 3: Push the existing branch**

Run:

```powershell
git push -u origin codex/zeabur-graceful-shutdown
```

Expected:

```text
Branch codex/zeabur-graceful-shutdown exists on origin.
```

- [ ] **Step 4: Open a pull request**

Use GitHub UI or GitHub connector:

```text
Base: main
Compare: codex/zeabur-graceful-shutdown
Title: fix: handle graceful shutdown on deploy
Body:
- Adds SIGTERM/SIGINT graceful shutdown.
- Stops runtime services before closing the HTTP server.
- Adds regression tests for clean shutdown and failed shutdown.
- Verification: npm run check, npm test, npm run build.
```

Expected:

```text
PR exists and CI starts against the pushed commit.
```

- [ ] **Step 5: Merge only after CI passes**

Expected:

```text
GitHub main contains commit e0fa69d or a merge commit that includes e0fa69d.
```

- [ ] **Step 6: Verify Zeabur deployed the new GitHub main SHA**

Check Zeabur deployment details and record:

```text
Zeabur service id
Zeabur deployment id
Git commit SHA
Build source
Runtime image or builder
Started at timestamp
```

Expected:

```text
Production is no longer running be9e589 if the graceful shutdown PR has been merged.
Production is running the new main SHA that includes graceful shutdown.
```

- [ ] **Step 7: Post-deploy live checks**

Run:

```powershell
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/api/health' -TimeoutSec 20
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/ready' -TimeoutSec 20
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/live' -TimeoutSec 20
npm run smoke:live -- --base-url https://barcode-scan.zeabur.app
```

Expected:

```text
/api/health status is healthy.
/ready ready is true.
/live alive is true.
Live smoke has 0 fail. Credential-gated checks may remain blocked until Task 5 is done.
```

---

### Task 2: Move Runtime Data To Zeabur Persistent Disk

**Files:**
- Optional create: `docs/operations/zeabur-stability-log.md`

**Interfaces:**
- Consumes: Zeabur persistent disk mount path.
- Produces: stable runtime directories for logs, backups, and local app state outside the ephemeral container image.

- [ ] **Step 1: Confirm Zeabur disk mount path**

In Zeabur service:

```text
Open salary-count-barcode-scan-public service.
Open Hard Disk tab.
Record the mounted path.
```

Expected:

```text
Mount path is known, for example /data or another Zeabur-provided path.
Do not guess the path if the UI does not show it.
```

- [ ] **Step 2: Set runtime path variables**

In Zeabur Variables, set these values using the actual mount path from Step 1:

```text
APP_RUNTIME_DIR=<mount-path>/barcode_scan_V3
APP_BACKUP_DIR=<mount-path>/barcode_scan_V3/backups
APP_LOG_DIR=<mount-path>/barcode_scan_V3/logs
```

Expected:

```text
All three APP_* variables point to the persistent disk mount, not /app and not the repository workspace.
```

- [ ] **Step 3: Redeploy after variable change**

Use Zeabur redeploy for the current production commit.

Expected:

```text
New deployment starts successfully.
No startup error says production runtime paths are inside the workspace.
```

- [ ] **Step 4: Verify backup and log behavior**

Run:

```powershell
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/api/health' -TimeoutSec 20
```

Then use SUPER admin UI to:

```text
Open backup list.
Create a manual backup.
Confirm the backup appears after refresh.
```

Expected:

```text
Health remains healthy.
Manual backup appears and survives at least one redeploy.
```

---

### Task 3: Enable Protected Scanner Device Flow

**Files:**
- No repository file changes expected unless scanner client config is stored in a separate repo.

**Interfaces:**
- Consumes: one generated random token shared between Zeabur and the scanner device.
- Produces: `/api/raspberry-scan` no longer disabled in production.

- [ ] **Step 1: Generate a device token without printing it in chat**

Run locally:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Expected:

```text
One opaque token is generated locally.
Do not paste the token into issue comments, chat, PR body, or logs.
```

- [ ] **Step 2: Set Zeabur variable**

In Zeabur Variables:

```text
SCAN_DEVICE_TOKEN=<generated-token>
```

Expected:

```text
Variable exists in Zeabur and is masked by the platform.
```

- [ ] **Step 3: Update the real scanner device**

On the Raspberry Pi or scanner client, set the same token in its runtime configuration.

Expected:

```text
Scanner sends the token in the application-supported header or auth field used by /api/raspberry-scan.
The token value is not committed to Git.
```

- [ ] **Step 4: Redeploy and verify endpoint behavior**

Run:

```powershell
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/api/health' -TimeoutSec 20
```

Then perform one real scanner request from the device.

Expected:

```text
Production logs no longer warn that SCAN_DEVICE_TOKEN is not set.
Invalid token requests return 401 or 403.
Valid device requests reach the scan handler.
```

---

### Task 4: Remove Plain Bootstrap Admin PIN Risk

**Files:**
- Optional create: `docs/operations/zeabur-stability-log.md`

**Interfaces:**
- Consumes: current database admin settings and Zeabur `DEFAULT_ADMIN_PIN` variable presence.
- Produces: no reusable low-entropy default admin PIN remains in production variables once the DB already has a real admin PIN.

- [ ] **Step 1: Confirm production has a real admin PIN configured**

Use the admin UI:

```text
Log in as an operator.
Open system settings or admin PIN management.
Confirm the admin PIN has already been explicitly configured.
```

Expected:

```text
Operator can log in without relying on DEFAULT_ADMIN_PIN bootstrap.
```

- [ ] **Step 2: Remove or rotate DEFAULT_ADMIN_PIN in Zeabur**

Preferred action:

```text
Delete DEFAULT_ADMIN_PIN from Zeabur Variables.
```

Fallback action if bootstrap is still needed temporarily:

```text
Set DEFAULT_ADMIN_PIN to a newly generated high-entropy temporary value.
Schedule deletion immediately after confirming admin settings are stored in DB.
```

Expected:

```text
Production no longer keeps a reusable six-digit DEFAULT_ADMIN_PIN variable.
SUPER_ADMIN_PIN remains hashed, not plaintext.
```

- [ ] **Step 3: Redeploy and verify login**

Run:

```powershell
Invoke-RestMethod -Uri 'https://barcode-scan.zeabur.app/api/health' -TimeoutSec 20
```

Then manually verify:

```text
Admin login works.
SUPER admin escalation works with the hashed SUPER_ADMIN_PIN-backed flow.
```

Expected:

```text
No startup crash.
No log message says SUPER_ADMIN_PIN must be hashed in production.
```

---

### Task 5: Unblock Credential-Gated Smoke Checks

**Files:**
- No repository file changes expected.

**Interfaces:**
- Consumes: operator-provided admin PIN, super admin PIN, and a real LINE test identity.
- Produces: live smoke can test authenticated admin, SUPER, and LINE paths instead of classifying them as blocked.

- [ ] **Step 1: Run smoke with admin and SUPER credentials in local process env**

Run in a local terminal only:

```powershell
$env:ADMIN_PIN='<operator-enters-admin-pin-locally>'
$env:SUPER_ADMIN_PIN='<operator-enters-super-pin-locally>'
npm run smoke:live -- --base-url https://barcode-scan.zeabur.app
Remove-Item Env:\ADMIN_PIN
Remove-Item Env:\SUPER_ADMIN_PIN
```

Expected:

```text
Admin and SUPER smoke checks move from blocked to pass or fail.
No PIN appears in shell history screenshots, PRs, logs, or chat.
```

- [ ] **Step 2: Verify LINE with a real test account**

Use a dedicated LINE test account:

```text
Open /api/line/login through the real production domain.
Complete LINE authorization.
Bind the test employee if required.
Trigger one clock-in flow.
```

Expected:

```text
LINE login and callback complete.
Webhook accepts valid signatures.
Interactive smoke blockers can be marked manually verified.
```

---

### Task 6: Resolve Or Escalate Zeabur `1/1181`

**Files:**
- Optional create: `docs/operations/zeabur-stability-log.md`

**Interfaces:**
- Consumes: Zeabur deployment history, pod list, runtime logs, and health checks.
- Produces: either a clean Zeabur service display or a support-ready evidence bundle proving the display is stale platform history.

- [ ] **Step 1: Record baseline before the new graceful-shutdown deployment**

Capture:

```text
Current Zeabur status number, for example 1/1181.
Current running pod id.
Current abnormal pod ids visible in the dropdown.
Current deployment id.
Current Git commit SHA.
Last 100 runtime log lines.
```

Expected:

```text
Baseline distinguishes active running pod from old abnormal pods.
```

- [ ] **Step 2: Deploy the graceful shutdown SHA from Task 1**

Expected:

```text
New pod starts.
Old pod receives SIGTERM.
Logs show clean shutdown or at least no exit 1 startup validation error.
```

- [ ] **Step 3: Observe the next rollout**

After deployment, wait 5 to 10 minutes and capture:

```text
Zeabur status number.
Running pod id.
Runtime logs around deployment timestamp.
/api/health output.
/ready output.
/live output.
```

Expected:

```text
If the number improves, keep monitoring.
If it remains 1/1181 but health is green and only one current pod is active, treat it as stale platform history or retained old pods.
```

- [ ] **Step 4: Check for real failure signatures**

Search Zeabur logs after the new deployment timestamp for:

```text
500
Unhandled request error
process exited
OOMKilled
Error: SUPER_ADMIN_PIN must be hashed in production
DATABASE_URL
SESSION_SECRET
SESSION_SECURE
```

Expected:

```text
No new startup validation crash.
No OOMKilled.
No repeated unhandled 500 from the same endpoint.
```

- [ ] **Step 5: If health is green but `1/1181` remains, open Zeabur support ticket**

Support ticket body:

```text
Service: salary-count-barcode-scan-public
Project id: 69dae9ee33eaacafd4337c5b
Service id: 69dae9fa33eaacafd4337c5d
Domain: https://barcode-scan.zeabur.app
Symptom: UI shows 1/1181 with many old pods marked abnormal restart, while one current pod is running and health probes are green.
Evidence:
- Current deployment id
- Current Git commit SHA
- Current running pod id
- Screenshot of 1/1181 dropdown
- /api/health, /ready, /live responses after deployment
- Runtime logs around the latest deployment showing no current CrashLoop
Request: Please confirm whether old abnormal pod history can be cleared or whether a stale ReplicaSet/pod accounting issue exists for this service.
```

Expected:

```text
Zeabur confirms stale history/accounting, clears it, or identifies a current platform-level restart reason.
```

- [ ] **Step 6: Last resort only if support confirms service metadata is stuck**

If Zeabur says the service record is unrecoverably stale:

```text
Create a new Zeabur service from the same GitHub main SHA.
Copy variables manually without exposing secrets in chat.
Attach the same persistent disk strategy or migrate backups first.
Run health and smoke checks.
Move the barcode-scan.zeabur.app domain only after the new service is verified.
Keep the old service stopped but not deleted until backups and logs are confirmed.
```

Expected:

```text
New service display is clean.
Domain points to verified service.
No production data loss.
```

---

## Execution Order

1. Task 1: publish and deploy graceful shutdown fix.
2. Task 6 steps 1 to 4: measure whether `1/1181` is still active after the new SHA.
3. Task 2: configure persistent runtime paths.
4. Task 3: enable scanner token.
5. Task 4: remove or rotate bootstrap admin PIN risk.
6. Task 5: unblock authenticated and LINE smoke checks.
7. Task 6 steps 5 to 6: escalate to Zeabur only if the display remains stale with green health and clean logs.

## Rollback Rules

- If `/api/health` is unhealthy after Task 1 deployment, rollback to the previous Zeabur deployment and preserve logs.
- If app startup fails with config validation, fix the named variable and redeploy; do not change application code first.
- If memory rises near platform limit or logs show `OOMKilled`, temporarily raise Zeabur memory and inspect backup/PDF/report concurrency before adding new features.
- If scanner requests fail after Task 3, rollback only the scanner token variable and device config together.
- If admin login fails after Task 4, restore the previous variable state only long enough to regain access, then set a proper DB-backed admin PIN.

## Completion Criteria

- Production Zeabur deployment SHA includes the graceful shutdown fix.
- `/api/health`, `/ready`, and `/live` are green after deployment.
- `npm run smoke:live -- --base-url https://barcode-scan.zeabur.app` has 0 fail; any remaining blocked item has an explicit operator reason.
- `APP_RUNTIME_DIR`, `APP_BACKUP_DIR`, and `APP_LOG_DIR` point to persistent disk.
- `SCAN_DEVICE_TOKEN` exists in Zeabur and on the real scanner device.
- `DEFAULT_ADMIN_PIN` is removed or no longer a reusable six-digit bootstrap value.
- No new logs after the latest deployment show `process exited` with exit 1, `OOMKilled`, plaintext `SUPER_ADMIN_PIN`, repeated `Unhandled request error`, or unexplained 500.
- Zeabur `1/1181` is either corrected or escalated with the support evidence bundle above.

## Self-Review

- Spec coverage: The four gaps are covered by Tasks 1 to 4. The smoke blockers are covered by Task 5. The `1/1181` path is covered by Task 6.
- Placeholder scan: No task uses TBD, TODO, or unspecified validation language.
- Type consistency: No new code interfaces are introduced beyond the already implemented graceful shutdown module.
