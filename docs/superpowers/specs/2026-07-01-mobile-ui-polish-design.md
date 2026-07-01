# Design: Mobile UI Polish (Touch Targets, Confirm Modal, A11y, Icons, Contrast)

- Date: 2026-07-01
- Status: Approved
- Priority: 3 of 3 (fully independent of the other two — frontend-only, can be built in parallel with either backend item if desired)
- Related: docs/CODE_AUDIT_REPORT_2026-07-01.md (前端 UI/UX section)

## Problem

Five specific, low-risk UI issues found during the front-end audit:
1. Mobile card action buttons use `size="sm"` (36px) / `size="icon"` (40×40px), below the 44×44px touch-target convention.
2. `AttendanceTable.tsx:206` uses the native `window.confirm()` instead of the app's own `ConfirmationModal`, breaking visual consistency.
3. Icon-only buttons in `HistoryTable.tsx` / `EmployeesTableCard.tsx` rely on `title` only, no `aria-label`.
4. `AttendancePage.tsx` / `HistoryPage.tsx` still use the Material Icons ligature font (`<span className="material-icons">`) while the rest of the app uses `lucide-react`; a failed font load renders raw English words.
5. `--ink-3` (`#8e948e`) is used for small text (11px bottom-nav labels, footer) against `--paper` (`#fbfaf6`), close to/below WCAG AA 4.5:1 contrast.

## Approach

Confirmed via visual companion review (button size mockup, contrast mockup, icon mockup):
- Touch targets: add a new `size="mobile"` variant to `button.tsx` rather than changing the shared `default`/`sm`/`icon` sizes globally — keeps desktop visuals untouched, scoped fix.
- Contrast: fix specific low-contrast usage sites (bottom nav label, footer) by switching them to `--ink-2`, rather than darkening the `--ink-3` token itself — token stays available for its original "intentionally muted" use elsewhere.
- Icons: full replacement of `material-icons` with `lucide-react` (confirmed, not partial).

## Design

### Components

1. **`client/src/components/ui/button.tsx`**
   - Add `size: { ..., mobile: "h-11 w-11" }` to the `buttonVariants` size variant (44px = `h-11 w-11` in Tailwind's default scale).
   - No change to `default`/`sm`/`lg`/`icon` or `defaultVariants`.

2. **`client/src/components/HistoryTable.tsx`** (mobile card action buttons, ~lines 162-247)
   - Change action buttons from `size="sm"` to `size="mobile"` in the mobile-card branch only (the `md:hidden` card rendering), not the desktop table branch.
   - Add `aria-label` to each icon-only button (download/print/edit/delete), matching the existing `title` text.

3. **`client/src/pages/employees/components/EmployeesTableCard.tsx`** (~lines 113-217)
   - Same two changes: `size="mobile"` on the card action buttons, `aria-label` added to copy/edit/delete icon buttons.

4. **`client/src/components/AttendanceTable.tsx:206`**
   - Replace `window.confirm(...)` with the existing `ConfirmationModal` component (same pattern already used in `HistoryPage`/`EmployeesPage`) — open the modal, delete on confirm.

5. **`client/src/pages/AttendancePage.tsx`** (lines ~507, 738) and **`client/src/pages/HistoryPage.tsx`** (lines ~478, 587, 600, 617)
   - Replace each `<span className="material-icons">iconName</span>` with the matching `lucide-react` icon component already used elsewhere in the app (e.g. `search` → `Search`, `delete` → `Trash2`, `print` → `Printer`, `download`/`file_download` → `Download`), sized/styled to match surrounding lucide usage.

6. **`client/src/index.css`** and consuming components
   - `AppShell.tsx:133` (bottom nav label, ~11px) and `:229`/`:378-379` (footer/header small text) — change `color: var(--ink-3)` to `var(--ink-2)` at these specific usage sites. `--ink-2`/`--ink-3` token definitions in `index.css:101-102` are unchanged.
   - Grep for any other sub-12px text currently using `--ink-3` against a `--paper*` background while doing this pass, and apply the same fix if found, to avoid leaving other instances of the same underlying issue.

### Data flow / state

No data flow changes — this is presentation-layer only. `ConfirmationModal` swap follows the same open/confirm/cancel state pattern already used in `HistoryPage.tsx`/`EmployeesPage.tsx`.

### Error handling

Not applicable — no new async operations or error paths introduced.

### Testing

Pure style/markup changes; no new automated tests. Verification is manual:
- Use the `run` skill (or equivalent) to launch the dev server and check, at both desktop and mobile (≤768px) viewport widths:
  - HistoryTable and EmployeesTableCard mobile card buttons are visibly larger (44px) and desktop table buttons are unchanged.
  - Deleting an attendance record shows the app's `ConfirmationModal`, not a native browser dialog.
  - Icon-only buttons expose accessible names (check via browser devtools accessibility tree, not just visual).
  - AttendancePage/HistoryPage icons render as lucide icons identical in style to the rest of the app, with no visible text fallback.
  - Bottom nav labels and footer text are visibly more legible against the paper background at small size.

## Out of scope

- No explicit CSS/ARIA automated test suite exists for this app; not introducing one as part of this change.
- Other UI issues not flagged in the audit (e.g., broader design-system pass) are out of scope.
- CSRF token mechanism, session cookie config, and other non-UI items from the audit are unrelated to this spec.
