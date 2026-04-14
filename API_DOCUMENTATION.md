# API Documentation

Current runtime contract for `barcode_scan_V3`.

## Overview
- Base URL: same origin as the deployed app.
- Format: JSON for API requests and responses unless noted otherwise.
- Timezone: Asia/Taipei.
- Authentication: admin access is session-based.
- Cookie name: `employee_salary_admin.sid`.
- Session defaults: `SameSite=Strict`, `HttpOnly=true`, `Secure=true` in production.
- If LINE OAuth is used, set `SESSION_SAME_SITE=lax` because the LINE redirect back to `/api/line/callback` is cross-site.

## Admin Session
All admin routes use the session cookie. The login flow is PIN-based, but the result is a server session.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/verify-admin` | Public | Verifies either the standard admin PIN or `SUPER_ADMIN_PIN` and creates the corresponding admin session. |
| `GET` | `/api/admin/session` | Public | Returns current admin session state. |
| `POST` | `/api/admin/logout` | Admin session | Clears the admin session. |
| `POST` | `/api/admin/elevate-super` | Admin session | Promotes an admin session to SUPER after validating `SUPER_ADMIN_PIN`. |
| `POST` | `/api/update-admin-pin` | SUPER session | Updates the stored admin PIN. Requires `oldPin` and `newPin`. |

## Health
| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Health summary with database and memory checks. |
| `GET` | `/ready` | Public | Readiness probe, focused on database connectivity. |
| `GET` | `/live` | Public | Liveness probe. |

## Employees
| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/employees` | Admin session | Public employee profile list for admin UI. |
| `GET` | `/api/employees/admin` | Admin session | Full admin-facing employee view. |
| `GET` | `/api/employees/deleted` | Admin session | Deleted employee recycle-bin view. |
| `GET` | `/api/employees/:id` | Admin session | Employee detail. |
| `POST` | `/api/employees` | Admin session | Create employee. Supports encrypted ID mode via `useEncryption`. |
| `PUT` | `/api/employees/:id` | Admin session | Replace employee fields. |
| `PATCH` | `/api/employees/:id` | Admin session | Partial update, including special leave metadata. |
| `DELETE` | `/api/employees/:id` | Admin session | Soft-delete employee. |
| `POST` | `/api/employees/:id/restore` | Admin session | Restore from recycle bin. |
| `DELETE` | `/api/employees/:id/purge` | SUPER session | Permanent purge and salary anonymization. Requires `confirmName`. |

## Attendance
`GET /api/attendance` and `GET /api/salary-records` now default to bounded pagination. If `page` or `limit` is omitted, the route still returns a paginated payload with `page=1` and `limit=50`.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/attendance` | Admin session | Attendance list. Always returns `{ data, pagination }`. Optional `page` and `limit` override the defaults. |
| `GET` | `/api/attendance/today` | Public with kiosk access | Today's barcode-scanned records. Requires kiosk unlock or admin session. |
| `POST` | `/api/attendance` | Admin session | Create a temporary attendance record. |
| `PUT` | `/api/attendance/:id` | Admin session | Update a temporary attendance record. |
| `DELETE` | `/api/attendance/:id` | Admin session | Delete one attendance record. |
| `DELETE` | `/api/attendance` | Admin session | Delete all temporary attendance records. |
| `DELETE` | `/api/attendance/employee/:employeeId` | Admin session | Delete attendance records for one employee. |

## Salary Records
Salary totals are recalculated from the standard calculator plus any active database-loaded rules. No employee-specific fallback behavior is built into the public contract.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/salary-records` | Admin session | Salary record list. Always returns `{ data, pagination }`. Optional `page` and `limit` override the defaults. |
| `GET` | `/api/salary-records/:id` | Admin session | Salary record detail. |
| `POST` | `/api/salary-records` | Admin session | Create a salary record. Server recalculates derived fields. |
| `PATCH` | `/api/salary-records/:id` | Admin session | Partial update. Server recalculates unless `x-force-update: true` is sent. |
| `DELETE` | `/api/salary-records/:id` | Admin session | Delete salary record. |
| `GET` | `/api/salary-records/:id/pdf` | Admin session | Redirects to the printable salary view. |
| `GET` | `/api/test-salary-calculation` | Admin session, non-production only | Debug endpoint for formula checks. Do not treat as a public contract. |

## Settings And Database Status
`GET /api/settings` returns the public settings payload only. The admin variant includes deductions and allowances.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/settings` | Public | Public salary settings. Bootstraps defaults if missing. |
| `GET` | `/api/settings/admin` | Admin session | Full settings payload. |
| `POST` | `/api/settings` | Admin session | Update settings. Changing `adminPin` requires SUPER session. |
| `GET` | `/api/db-status` | Admin session | Database provider and connectivity summary. |
| `GET` | `/api/supabase-config` | Admin session | Read-only status view. Runtime switching is disabled. |
| `POST` | `/api/supabase-config` | SUPER session | Always returns `409` in production runtime. |
| `GET` | `/api/supabase-connection` | Admin session | Connectivity probe. |
| `POST` | `/api/supabase-toggle` | SUPER session | Always returns `409` in production runtime. |
| `POST` | `/api/supabase-migrate` | SUPER session | Always returns `409` in production runtime. |

## Holidays
| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/holidays` | Admin session | List custom holidays. |
| `POST` | `/api/holidays` | Admin session | Create holiday. Also backfills a temporary attendance record when needed. |
| `DELETE` | `/api/holidays/:id` | Admin session | Delete one holiday. |
| `DELETE` | `/api/holidays` | Admin session | Delete all holidays. |

## Calculation Rules
Special cases are data-driven. Add or update rules here instead of relying on hardcoded employee/month overrides.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/calculation-rules` | SUPER session | List calculation rules. |
| `POST` | `/api/calculation-rules` | SUPER session | Create a rule and reload the in-memory rule set. |
| `PUT` | `/api/calculation-rules/:id` | SUPER session | Update a rule and reload the in-memory rule set. |
| `DELETE` | `/api/calculation-rules/:id` | SUPER session | Delete a rule and reload the in-memory rule set. |

## Scan And Kiosk
`barcodeEnabled=false` disables the scan endpoints and makes them return `503`.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/scan/session` | Public | Reports scan kiosk session status. |
| `POST` | `/api/scan/session/token` | Admin session | Issues a short-lived unlock token for a kiosk challenge. |
| `POST` | `/api/scan/session/unlock` | Public, token-based | Unlocks the scan kiosk session. |
| `POST` | `/api/scan/session/lock` | Public | Clears the scan kiosk session. |
| `GET` | `/api/last-scan-result` | Public with kiosk access | Returns the latest scan result for the current day. |
| `POST` | `/api/barcode-scan` | Public with kiosk access | Barcode scan endpoint. Uses the kiosk session or admin session. |
| `POST` | `/api/raspberry-scan` | Device token protected | Raspberry Pi scan endpoint. Requires `x-scan-device-token` when configured or in production. |

## Import
| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/admin/import/attendance` | Admin session | Imports attendance CSV from `csvContent`. |
| `POST` | `/api/admin/import/salary-record` | Admin session | Imports one salary record from `csvContent`. |

## Taiwan Holidays
| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/taiwan-holidays` | SUPER session | List Taiwan holidays, optionally filtered by `year`. |
| `POST` | `/api/taiwan-holidays/import` | SUPER session | Bulk import Taiwan holidays. |
| `DELETE` | `/api/taiwan-holidays/:id` | SUPER session | Delete one Taiwan holiday. |

## LINE Integration
LINE routes are registered when LINE environment variables are configured. If LINE is not configured, the routes stay registered but respond with disabled-mode errors where appropriate.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/line/config` | Public | Returns whether LINE is configured. |
| `GET` | `/api/line/login` | Public | Starts LINE login and stores OAuth state. |
| `GET` | `/api/line/callback` | Public | Handles LINE OAuth callback and creates LINE session data. |
| `GET` | `/api/line/temp-data` | LINE session | Returns temporary LINE session data. |
| `POST` | `/api/line/liff-auth` | Public | Validates a LIFF access token and stores LINE session data. |
| `POST` | `/api/line/bind` | LINE session | Requests employee binding for the current LINE user. |
| `GET` | `/api/line/binding-status/:lineUserId` | LINE session | Returns binding status for the current LINE user. |
| `GET` | `/api/line/pending-bindings` | Admin session | Lists pending bindings. |
| `POST` | `/api/line/pending-bindings/:id/approve` | Admin session | Approves a pending binding. |
| `POST` | `/api/line/pending-bindings/:id/reject` | Admin session | Rejects a pending binding. |
| `DELETE` | `/api/line/pending-bindings/:id` | Admin session | Deletes a pending binding. |
| `POST` | `/api/line/clock-in` | LINE session | LINE-based clock-in / clock-out action. |
| `POST` | `/api/line/webhook` | Public with LINE signature | Raw-body webhook endpoint. Requires `x-line-signature`. |

Webhook note: `/api/line/webhook` requires the raw JSON body, verifies the signature, and ignores stale events older than the replay window. It returns `200` after successful signature validation even if the JSON payload is not fully parsed.

## Dashboard Operations
Dashboard routes are SUPER-session only and are intended for operational workflows.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/dashboard/connection` | SUPER session | Database connectivity summary for operators. |
| `GET` | `/api/dashboard/connection-history` | SUPER session | Runtime connection history snapshot. |
| `GET` | `/api/dashboard/backups` | SUPER session | Lists available backups. |
| `POST` | `/api/dashboard/backups` | SUPER session | Creates a backup. |
| `POST` | `/api/dashboard/backups/:backupId/restore` | SUPER session | Restores from a validated backup ID. |
| `DELETE` | `/api/dashboard/backups/:backupId` | SUPER session | Deletes a validated backup ID. |
| `GET` | `/api/dashboard/logs` | SUPER session | Reads structured audit log entries. |
| `GET` | `/api/dashboard/logs/dates` | SUPER session | Lists available audit log dates. |
| `GET` | `/api/dashboard/operational-metrics` | SUPER session | Returns runtime secret-source, runtime-path, failure-counter, and latency telemetry. |
| `POST` | `/api/dashboard/sync` | SUPER session | Always returns `409` in PostgreSQL-only production mode. |
| `GET` | `/api/dashboard/consistency` | SUPER session | Always returns `409` in PostgreSQL-only production mode. |

## Response Conventions
- JSON success responses usually use `{ success: true }` or return a domain object directly.
- Validation errors use `400`.
- Unauthenticated or missing session access usually uses `401`.
- Permission failures usually use `403`.
- Missing records use `404`.
- Conflict / disabled production-only paths often use `409`.
- `204` means success with no response body.

## Legacy / Archived References
- `POST /api/login`, `POST /api/logout`, and `GET /api/user` are legacy references from older docs and are not current live routes.
- If you see older examples in external notes, treat `verify-admin` plus the admin session endpoints above as the current contract.
