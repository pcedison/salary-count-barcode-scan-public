# Payroll repair acceptance, 2026-10-01

This report uses synthetic identities and isolated databases. It does not authorize
or claim a production migration, salary correction, payment or re-settlement.
Production baseline: public `main` at `6d819f03fefe33d3daa5905c5510d7c23afeb604`,
version 2.2.1. The private PR #12 is a separate repository and deployment line.

| Previous failure | Repaired behavior | Candidate acceptance |
| --- | --- | --- |
| P1: backup omitted correction journal | Authority v3 exports a consistent snapshot; locked restore preserves projections, journal and sequences; incompatible legacy restore fails before mutation | Actual PostgreSQL backup runner 33/33, including nonempty required check and rehearsal |
| P2: `8:00` was accepted by import but rejected by correction | Shared clock parser accepts one- or two-digit hours and validates bounds | Connected Chrome preview preserves `8:00`, gives the expected synthetic worked-holiday delta, and cancellation writes nothing |
| PDF long months clipped deductions and totals | Natural A4 pagination repeats identity/columns, keeps monetary rows complete and starts each employee on a new page | 7 actual PDFs, 11 pages visually inspected, 167 checks; stored CSV/PDF amounts agree |
| Historical welfare detail disagreed with saved total | Saved total remains authoritative; signed reconciliation exposes missing/contradictory detail | Positive, negative, complete and missing detail PDF cases pass |
| Old-binary backout could overwrite corrections | Separate compatible maintenance build blocks HTTP, repository, batch, automation, retention and legacy JSON backup writes; strict production startup | 27 actual HTTP attempts blocked; salary/journal fingerprints unchanged; desktop/mobile reads remain available |
| New public settlements omitted calculation basis | Calculation builder captures the actual monthly base; manual edits and CSV preserve the archived basis or legacy null | Actual PostgreSQL new/atomic/rerun/manual/CSV cases pass |
| Ordinary administrator credentials could elevate SUPER outside production | Every environment requires an independently configured supported SUPER hash | 17 direct auth cases and HTTP elevation regressions pass; production hashed flow remains compatible |
| Latest journal and same-revision salary could contradict each other | Compare all archived payroll fields while preserving audit redaction and legal retention changes; a null link cannot bypass an extant projection | Corrupted artifacts are refused before mutation; retained and higher-automation-revision cases still restore |
| Fresh restore could reuse a deleted salary's retained audit ID | Salary sequence reserves the maximum journal original ID as well as live IDs and the existing sequence highwater | Actual fresh database restore, next salary insert and first correction keep old/new histories separate |
| CSV offered a record-ID target that could never succeed | Offer only the explicit employee target and direct existing/revised records to correction preview | Direct form tests and connected Chrome desktop/390px mobile pass; export IDs and backend protection remain unchanged |

Public candidate: TypeScript, build and runtime audit pass; 650 unit tests and
201 smoke tests pass (overlap exists; do not sum them). Actual PostgreSQL correction
runner: 30/30; backup: 33/33; external whole-database recovery session invalidation:
6/6. The generic release command's restore check skips without DATABASE_URL;
the separate guarded backup runner supplies a nonempty backup and mandatory checks.

Connected Chrome desktop/mobile acceptance passed duplicate and cross-month
rejection, canceled preview, two unworked national holidays with zero delta,
double confirmation with one revision, and two concurrent correction windows
where the stale window is refused. Reopening history shows the saved revision and
intent. A separate synthetic personal-leave replacement removed the recorded
deduction rather than blindly adding two wages. These are synthetic calculations,
not production compensation decisions.

Actual isolated API/DB CSV acceptance: 9/9. Fresh-month import succeeds and preserves
stored totals; repeat import, revised CSV, stale PATCH and deleting corrected
records are refused. Browser CSV downloads exactly match the public exporter.
The original four salary rows, two journals and other business tables were unchanged
by the CSV checks; only the explicitly allowed new-month synthetic row was added.

Independent source review found no additional reproducible P1/P2 in the repaired
restore, session epoch, repository, CSV and maintenance paths. Synthetic fixtures
never reset an existing or external database. Original user checkouts were preserved.

## Native backup rehearsal scope

A native PostgreSQL 17 full logical database archive was created with an exported
read-only snapshot and certificate/hostname verification. A separate copy outside
the ephemeral container was hashed, encrypted for the current Windows account and
successfully decrypted back to the same archive hash. No backup contents or
employee data are included in this repository.

All 11 public application tables were actually restored to an empty isolated
PostgreSQL 17 database. Counts, raw row fingerprints, column/default fingerprints,
stored payroll aggregates and public sequences matched. All 51 archived table data
segments were readable. The initial UUID-default comparison used a different
search path; a fresh restore with the source search path passed without modifying
the source database or the archived default.

This verifies the application data restore, not a complete managed Supabase
platform recovery. The local restore omitted owner/ACL application; the archive
retains them. Cluster globals and managed storage object contents were not backed
up. The live baseline did not attest that all writers were drained, so it is not
the final migration cutpoint. No application was started against private raw copies.

## Remaining release gates

- Native Chrome file chooser upload remains unverified because the connected
  extension refused local-file access. Parser/API success does not prove that UI path.
- Local Windows PDF rendering does not prove the eventual Linux container's font
  rendering. Docker CI and deployed browser/PDF acceptance remain separate gates.
- The production service has no mounted volume at the read-only baseline; existing
  container JSON backups must not be treated as durable recovery copies.
- A final drained migration cutpoint, runtime PDF preservation, old-instance drain,
  additive migration and post-deployment smoke checks remain separate operations.
  See [the release and recovery runbook](PAYROLL_CORRECTION_RELEASE_RUNBOOK.md).
- Unknown historical calculation bases, actual attendance, holiday transfers and
  payment status require operator review; classification alone is not evidence of
  an underpayment. National holidays without attendance already included in monthly
  salary can have a zero correction delta.
