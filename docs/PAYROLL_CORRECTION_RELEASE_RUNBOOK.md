# Payroll correction release and recovery

This is a release plan, not evidence of a production migration or payroll change.
Use synthetic identities in test results and pull requests. Never include employee
names, attendance exports, government identifiers, session cookies or secrets.

## Release gates

1. Verify the canonical deployment source. Zeabur production for
   `https://barcode-scan.zeabur.app` follows `pcedison/salary-count-barcode-scan-public`
   `main`. The private PR does not publish to that repository automatically.
2. Finish unit, HTTP, build, database, backup/restore, PDF and desktop/mobile
   acceptance in isolated environments. Public and private implementations have
   different repository boundaries; validate both. Preserve their original
   dependency, authentication and deployment policies.
3. Prepare a **compatible maintenance build** based on the current public release:
   it must contain `PAYROLL_WRITES_PAUSED` guards in HTTP routes, salary and batch
   repositories, monthly automation and retention. Test its legacy salary handlers
   with maintenance enabled. Record the exact commit and image as the backout
   target before changing schema. An unmodified old binary ignores this variable
   and is not a safe rollback target.
4. Set `PAYROLL_WRITES_PAUSED=true`, deploy the compatible maintenance build, wait
   for the deployment to finish and verify salary reads remain available and all
   salary mutation routes, import, automation and retention are paused. Drain old
   instances and in-flight requests, including login, before migration. Correction
   tokens are signed and stateless; a restart with the same secret does not revoke
   them. A restored database advances a persistent administrator session epoch,
   invalidates saved administrator sessions and forces a fresh login and preview.
   The pause affects payroll editing/settlement, import and scheduled payroll
   processing. Communicate the maintenance window to the operator.
5. Produce a fresh full PostgreSQL backup through platform tooling and validate it; verify persistent backup storage and
   retain a copy independent of the application container. The compatibility
   maintenance artifact disables legacy application JSON backup creation and restore;
   do not use its exporter after the new journal exists. Record counts and stored
   gross, deduction and net totals. The backup contains private data and must not
   be attached to a PR or published. Rehearse restoration using a disposable copy.
   At the read-only 2026-10-01 baseline, Zeabur showed no mounted volume and the
   JSON backup log pointed inside the container. Such files are not a durable
   migration recovery source; preserve an independent copy before deployment.
6. Obtain the operator's explicit approval for production migration, showing the
   SQL, affected tables, backup identifier, maintenance/backout plan and payroll
   delta. Deployment approval does not authorize a production salary correction,
   re-settlement or unapproved database migration.
7. Apply only the reviewed additive SQL migration. It adds `salary_records.revision`
   (default 0), nullable `holiday_calculation_base_salary`, `salary_corrections`,
   its indexes and access restrictions. Existing monetary amounts, attendance,
   deductions and employee identities are unchanged; migration payroll delta is 0.
   Do not run an unrestricted schema sync or remove the new journal in recovery.
8. Merge the validated public feature PR and wait for required GitHub checks and
   Zeabur deployment success. Verify both the source SHA and the deployed release;
   a successful push or a frontend version string alone is insufficient.
9. Use the connected browser to verify production reads and non-saving previews.
   Keep payroll writes paused until the operator approves resuming them. Verify
   settings, archived salary details, export/PDF and correction preview without
   saving changes or invoking monthly processing. Repeat desktop/mobile checks.

## Restoring backups

Backup authority version 3 includes correction history. Export reads all included
tables in one repeatable-read snapshot; restoration locks them and replaces their
contents in one transaction. Restore correction rows after salary rows, reset all
included sequences, and preserve original revision, idempotency keys, request and
preview hashes, before/after snapshots, delta and nullable retention references.

For a production restore, first GET
`/api/dashboard/backups/:backupId/restore-preview?type=manual` with a SUPER session.
Review `liveCounts`, `backupCounts`, `replacedJournalRows`, `journalCoverage` and
`payrollTotals.before/after/delta` and **every `changedSalaryRecords` entry**.
Offsetting changes can leave aggregate delta at zero; classification-only changes
also appear even when their monetary delta is zero. Then explicitly confirm the same preview by
POSTing JSON to `/api/dashboard/backups/:backupId/restore` with
`confirmRestore: true`, its `confirmationToken`, and, when required,
`confirmJournalReplacement: true`. Include the selected backup type. Cross-origin
requests are refused. The route makes a safeguard backup only after confirmation.
The transaction rechecks freshness after acquiring locks; a changed database or
artifact requires a new preview. Successful restore expires administrator sessions,
so old correction previews require reauthentication and a fresh preview.

A legacy backup without the journal is allowed only when its salary revisions are
zero and the destination contains no correction journal or nonzero salary revision. Otherwise it is refused
without replacing data. Never synthesize missing audit evidence or clear a live
journal to make a legacy backup pass. A failed restore rolls back all data changes.

The application JSON backup covers its listed authority tables; it is not a full
PostgreSQL snapshot. `monthly_salary_runs` execution, PDF and email metadata are
not restored. Before resuming, separately reconcile run status against restored
payroll and delivery records. Never force a rerun or resend email to compensate
without approval. For schema migration recovery, retain a separately verified
full database backup as well as this application backup. Administrator epoch is
kept outside backup authority so an earlier backup cannot revive old logins.

A full PostgreSQL restore also restores `user_sessions` and the epoch. It bypasses
the application restore helper: do not assume administrator invalidation occurred.
Keep every application instance stopped or paused and drain requests, then run
`npm run restore:invalidate-admin-sessions -- --confirm` with an explicitly selected
`DATABASE_URL` and `PAYROLL_WRITES_PAUSED=true` before restarting writers. The command
does not load `.env`, refuses missing confirmation or maintenance before connecting,
and atomically removes administrator sessions and advances the epoch. It preserves
non-administrator scan/LINE sessions and fails if the session table is absent.
Verify its success before allowing logins or payroll writes. This operation belongs
to the separately approved full-database recovery; it is not authorization to run
a production restore. The isolated auth recovery check does not establish that an
external Zeabur full restore or old-instance drain has already been rehearsed.

Existing signed batch-print URLs have a five-minute lifetime and use a separate
print secret; the administrator epoch does not invalidate them. In an approved
full-database recovery, have the operator rotate `SALARY_PRINT_TOKEN_SECRET` on
every instance before allowing reads (or wait out and verify all existing tokens
with every instance stopped). Replacing credentials is an operator handoff, not
an automatic side effect of this migration or the session-invalidation command.

## Backout choices

- **Application problem:** keep the additive schema and current journal intact.
  Turn on maintenance and deploy the tested compatible maintenance commit. Confirm
  legacy editing, delete, CSV import, forced batch runs and retention cannot write;
  salary reads and stored amounts should match the pre-backout snapshot. Reverting
  only the interface or deploying the original old release is insufficient.
  The compatible maintenance artifact disables legacy JSON backup creation and
  restoration: that exporter cannot preserve the new journal. Use the verified
  full database snapshot, or the current repair build's version 3 backup tooling;
  do not produce new backups through the maintenance artifact.
- **Data recovery:** use the restore preview above. Restoring an earlier snapshot
  can replace newer payroll projections and journal entries. Show the exact counts
  and gross/deduction/net differences, preserve a current safeguard backup and get
  approval before executing. Restore the salary projection and its journal together.
- **Resume:** inspect totals, journal integrity, sequences, session invalidation
  and idempotent correction replay in isolation. Deploy the validated repair build
  and clear maintenance only after the operator approves. Do not compensate by
  manually changing stored net salary or automatically adding holiday wages.

## Acceptance evidence

Run `npm run verify:release`, the guarded `npm run test:payroll-db` and
`npm run test:payroll-backup-db` against fresh loopback `payroll_test_*` databases.
Use the mandatory disposable flags; these runners reject external targets, an
existing schema, `.env` fallback and unapproved forwarded arguments. Test new and
same-database restoration, refused legacy recovery, confirmation freshness,
transaction rollback, sequences and administrator session invalidation. Verify
duplicate dates, cross-month dates, canceled preview, double confirmation,
concurrent edits, reopening history, CSV round trips and actual PDF amounts.

PDF acceptance includes a 31-day month, multiple allowances, eight deductions,
positive/negative/missing historical allowance detail and multiple employees.
Every date and monetary row must appear; every continuation repeats employee,
month, revision and column headings; the next employee starts a fresh page.
Compare stored gross/deduction/net totals with CSV and PDF. Rendering/export must
not mutate the archived record.
