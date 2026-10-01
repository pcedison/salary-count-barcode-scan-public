# Payroll repair acceptance, 2026-10-01

This report uses synthetic identities and isolated databases. It does not authorize
or claim a production migration, salary correction, payment or re-settlement.
Production baseline: public `main` at `6d819f03fefe33d3daa5905c5510d7c23afeb604`,
version 2.2.1. The private PR #12 is a separate repository and deployment line.

| Previous failure | Repaired behavior | Candidate acceptance |
| --- | --- | --- |
| P1: backup omitted correction journal | Authority v3 exports a consistent snapshot; locked restore preserves projections, journal and sequences; incompatible legacy restore fails before mutation | Actual PostgreSQL backup runner 22/22, including nonempty required check and rehearsal |
| P2: `8:00` was accepted by import but rejected by correction | Shared clock parser accepts one- or two-digit hours and validates bounds | Connected Chrome preview preserves `8:00`, gives the expected synthetic worked-holiday delta, and cancellation writes nothing |
| PDF long months clipped deductions and totals | Natural A4 pagination repeats identity/columns, keeps monetary rows complete and starts each employee on a new page | 7 actual PDFs, 11 pages visually inspected, 167 checks; stored CSV/PDF amounts agree |
| Historical welfare detail disagreed with saved total | Saved total remains authoritative; signed reconciliation exposes missing/contradictory detail | Positive, negative, complete and missing detail PDF cases pass |
| Old-binary backout could overwrite corrections | Separate compatible maintenance build blocks HTTP, repository, batch, automation, retention and legacy JSON backup writes; strict production startup | 27 actual HTTP attempts blocked; salary/journal fingerprints unchanged; desktop/mobile reads remain available |
| New public settlements omitted calculation basis | Calculation builder captures the actual monthly base; manual edits and CSV preserve the archived basis or legacy null | Actual PostgreSQL new/atomic/rerun/manual/CSV cases pass |

Public candidate: TypeScript, build and runtime audit pass; 617 unit tests and
198 smoke tests pass (overlap exists; do not sum them). Actual PostgreSQL correction
runner: 30/30; backup: 22/22; external whole-database recovery session invalidation:
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

## Remaining release gates

- Native Chrome file chooser upload remains unverified because the connected
  extension refused local-file access. Parser/API success does not prove that UI path.
- Local Windows PDF rendering does not prove the eventual Linux container's font
  rendering. Docker CI and deployed browser/PDF acceptance remain separate gates.
- The production service has no mounted volume at the read-only baseline; existing
  container JSON backups must not be treated as durable recovery copies.
- Full production PostgreSQL backup, external restore rehearsal, old-instance drain,
  additive migration and post-deployment smoke checks have not been performed by
  this report. See [the release and recovery runbook](PAYROLL_CORRECTION_RELEASE_RUNBOOK.md).
- Unknown historical calculation bases, actual attendance, holiday transfers and
  payment status require operator review; classification alone is not evidence of
  an underpayment. National holidays without attendance already included in monthly
  salary can have a zero correction delta.
