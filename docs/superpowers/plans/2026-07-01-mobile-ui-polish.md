# Mobile UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 concrete front-end issues from the 2026-07-01 audit: undersized mobile touch targets, a native `window.confirm()` dialog, missing `aria-label`s on icon-only buttons, mixed Material Icons / lucide-react usage, and low-contrast small text.

**Architecture:** Pure presentation-layer changes — a new `size="mobile"` Button variant, targeted className/markup edits in the affected components, one native-dialog-to-modal swap, and a small return-type change in `attendanceSyncStatus.ts` (string icon name → Lucide icon component) to finish the icon migration for the one dynamic case.

**Tech Stack:** React 18, TypeScript, TailwindCSS, shadcn/ui (`class-variance-authority`), lucide-react `^0.453.0`.

**Related spec:** `docs/superpowers/specs/2026-07-01-mobile-ui-polish-design.md`

**Note on scope:** This plan is fully independent of the other two priority-fix plans (race-condition fix, storage repository split) — no shared files, can be executed before, after, or in parallel with either.

---

## File Structure

- **Modify:** `client/src/components/ui/button.tsx` — add `size="mobile"` variant.
- **Modify:** `client/src/components/HistoryTable.tsx` — mobile button sizing + desktop `aria-label`.
- **Modify:** `client/src/pages/employees/components/EmployeesTableCard.tsx` — mobile button sizing + desktop `aria-label`.
- **Modify:** `client/src/components/AttendanceTable.tsx` — replace `window.confirm` with `ConfirmationModal`.
- **Modify:** `client/src/pages/HistoryPage.tsx` — replace 3 static Material Icons with lucide-react.
- **Modify:** `client/src/lib/attendanceSyncStatus.ts` + `client/src/lib/attendanceSyncStatus.test.ts` — change `icon` from a Material Icons name string to a Lucide icon component.
- **Modify:** `client/src/pages/AttendancePage.tsx` — consume the new `syncBadge.icon` component + replace the static "add" icon.
- **Modify:** `client/src/components/layout/AppShell.tsx` — 10 low-contrast `--ink-3` text usages → `--ink-2`.

Out of scope (confirmed during brainstorming): `AttendanceTable.tsx`'s own Material Icons usage (lines 363, 373) and its mobile button sizes — not named in the approved spec, left untouched to avoid scope creep.

---

### Task 1: Add the `mobile` Button size variant

**Files:**
- Modify: `client/src/components/ui/button.tsx`

- [ ] **Step 1: Add the variant**

Change:

```typescript
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
```

to:

```typescript
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
        mobile: "h-11 px-4 py-2",
      },
```

`h-11` is 44px in Tailwind's default scale, meeting the touch-target convention. It deliberately does **not** set a fixed width (unlike `icon`), because every consumer of this variant in this plan is a full-width text+icon button (`className="w-full ..."`) — a fixed `w-11` here would fight with `w-full` in the consumer's className.

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ui/button.tsx
git commit -m "feat: add size=mobile Button variant for 44px touch targets"
```

---

### Task 2: Apply `size="mobile"` and `aria-label` in `HistoryTable.tsx`

**Files:**
- Modify: `client/src/components/HistoryTable.tsx`

- [ ] **Step 1: Add `aria-label` to the 4 desktop action buttons**

Change (`renderDesktopActions`, currently lines 160-199):

```typescript
  const renderDesktopActions = (record: HistoryRecord) => (
    <div className="flex items-center justify-center gap-1">
      <button
        className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        onClick={() => onDownloadPdf(record)}
        title="查看報表"
      >
        <Download size={16} />
      </button>

      <button
        className="rounded-full p-1 text-blue-500 hover:bg-blue-50 hover:text-blue-600"
        onClick={() => setLocation(`/print-salary?id=${record.id}`)}
        title="列印薪資單"
      >
        <Printer size={16} />
      </button>

      {onEditRecord && isAdmin && (
        <button
          className="rounded-full p-1 text-indigo-500 hover:bg-indigo-50 hover:text-indigo-600"
          onClick={() => onEditRecord(record)}
          title="編輯薪資記錄"
        >
          <Edit size={16} />
        </button>
      )}

      {onDeleteRecord && isAdmin && (
        <button
          className="rounded-full p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-800"
          onClick={() => onDeleteRecord(record.id)}
          disabled={isDeleting}
          title="刪除記錄"
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
```

to:

```typescript
  const renderDesktopActions = (record: HistoryRecord) => (
    <div className="flex items-center justify-center gap-1">
      <button
        className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        onClick={() => onDownloadPdf(record)}
        title="查看報表"
        aria-label="查看報表"
      >
        <Download size={16} />
      </button>

      <button
        className="rounded-full p-1 text-blue-500 hover:bg-blue-50 hover:text-blue-600"
        onClick={() => setLocation(`/print-salary?id=${record.id}`)}
        title="列印薪資單"
        aria-label="列印薪資單"
      >
        <Printer size={16} />
      </button>

      {onEditRecord && isAdmin && (
        <button
          className="rounded-full p-1 text-indigo-500 hover:bg-indigo-50 hover:text-indigo-600"
          onClick={() => onEditRecord(record)}
          title="編輯薪資記錄"
          aria-label="編輯薪資記錄"
        >
          <Edit size={16} />
        </button>
      )}

      {onDeleteRecord && isAdmin && (
        <button
          className="rounded-full p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-800"
          onClick={() => onDeleteRecord(record.id)}
          disabled={isDeleting}
          title="刪除記錄"
          aria-label="刪除記錄"
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
```

- [ ] **Step 2: Bump the 4 mobile action buttons to `size="mobile"`**

Change (`renderMobileActions`, currently lines 201-248), each of the 4 `<Button ... size="sm" ...>` to `size="mobile"`:

```typescript
  const renderMobileActions = (record: HistoryRecord) => (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button
        variant="outline"
        size="mobile"
        className="w-full justify-center sm:flex-1"
        onClick={() => onDownloadPdf(record)}
      >
        <Download className="h-4 w-4" />
        查看報表
      </Button>

      <Button
        variant="outline"
        size="mobile"
        className="w-full justify-center sm:flex-1"
        onClick={() => setLocation(`/print-salary?id=${record.id}`)}
      >
        <Printer className="h-4 w-4" />
        列印薪資單
      </Button>

      {onEditRecord && isAdmin && (
        <Button
          variant="outline"
          size="mobile"
          className="w-full justify-center sm:flex-1"
          onClick={() => onEditRecord(record)}
        >
          <Edit className="h-4 w-4" />
          編輯薪資記錄
        </Button>
      )}

      {onDeleteRecord && isAdmin && (
        <Button
          variant="destructive"
          size="mobile"
          className="w-full justify-center sm:flex-1"
          onClick={() => onDeleteRecord(record.id)}
          disabled={isDeleting}
        >
          <Trash2 className="h-4 w-4" />
          刪除記錄
        </Button>
      )}
    </div>
  );
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/HistoryTable.tsx
git commit -m "fix: 44px mobile touch targets and aria-labels in HistoryTable"
```

---

### Task 3: Apply `size="mobile"` and `aria-label` in `EmployeesTableCard.tsx`

**Files:**
- Modify: `client/src/pages/employees/components/EmployeesTableCard.tsx`

- [ ] **Step 1: Bump the 3 mobile card buttons to `size="mobile"`**

Change (currently lines 99-125):

```typescript
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      title="複製掃碼專用 ID"
                      onClick={() => handleCopyScanId(employee)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      複製掃碼 ID
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" className="w-full" onClick={() => onEdit(employee)}>
                    <Pencil className="h-4 w-4" />
                    編輯
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => onDelete(employee)}
                  >
                    <Trash2 className="h-4 w-4" />
                    刪除
                  </Button>
                </div>
```

to:

```typescript
                    <Button
                      variant="outline"
                      size="mobile"
                      className="shrink-0"
                      title="複製掃碼專用 ID"
                      onClick={() => handleCopyScanId(employee)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      複製掃碼 ID
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" size="mobile" className="w-full" onClick={() => onEdit(employee)}>
                    <Pencil className="h-4 w-4" />
                    編輯
                  </Button>
                  <Button
                    variant="outline"
                    size="mobile"
                    className="w-full text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => onDelete(employee)}
                  >
                    <Trash2 className="h-4 w-4" />
                    刪除
                  </Button>
                </div>
```

- [ ] **Step 2: Add `aria-label` to the 3 desktop icon-only buttons**

Change (currently lines 180-217):

```typescript
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-1 h-6 w-6"
                        title="複製掃碼專用 ID"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCopyScanId(employee);
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
```

to:

```typescript
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-1 h-6 w-6"
                        title="複製掃碼專用 ID"
                        aria-label="複製掃碼專用 ID"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCopyScanId(employee);
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
```

And change:

```typescript
                    <Button variant="ghost" size="icon" onClick={() => onEdit(employee)} title="編輯">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onDelete(employee)}
                      title="刪除"
                      className="text-red-500 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
```

to:

```typescript
                    <Button variant="ghost" size="icon" onClick={() => onEdit(employee)} title="編輯" aria-label="編輯">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onDelete(employee)}
                      title="刪除"
                      aria-label="刪除"
                      className="text-red-500 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
```

- [ ] **Step 3: Commit**

```bash
git add "client/src/pages/employees/components/EmployeesTableCard.tsx"
git commit -m "fix: 44px mobile touch targets and aria-labels in EmployeesTableCard"
```

---

### Task 4: Replace `window.confirm` with `ConfirmationModal` in `AttendanceTable.tsx`

**Files:**
- Modify: `client/src/components/AttendanceTable.tsx`

- [ ] **Step 1: Import `ConfirmationModal`**

Directly below `import { Loader2, XCircle } from 'lucide-react';` (line 13), add:

```typescript
import ConfirmationModal from '@/components/ConfirmationModal';
```

- [ ] **Step 2: Add delete-confirmation state**

Directly below `const [updatingHolidayType, setUpdatingHolidayType] = useState<number | null>(null);` (line 126), add:

```typescript
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);
```

- [ ] **Step 3: Split `handleDelete` into a click handler and a confirm handler**

Change (currently lines 205-222):

```typescript
  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此考勤記錄嗎？')) return;

    try {
      await onDeleteAttendance(id);
      toast({
        title: "已刪除",
        description: "考勤記錄已成功刪除。",
      });
    } catch (error) {
      console.error('Failed to delete record:', error);
      toast({
        title: "刪除失敗",
        description: "無法刪除考勤記錄，請稍後再試。",
        variant: "destructive"
      });
    }
  };
```

to:

```typescript
  const handleDeleteClick = (id: number) => {
    setDeleteTargetId(id);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (deleteTargetId === null) return;

    try {
      await onDeleteAttendance(deleteTargetId);
      toast({
        title: "已刪除",
        description: "考勤記錄已成功刪除。",
      });
    } catch (error) {
      console.error('Failed to delete record:', error);
      toast({
        title: "刪除失敗",
        description: "無法刪除考勤記錄，請稍後再試。",
        variant: "destructive"
      });
    } finally {
      setIsDeleteModalOpen(false);
      setDeleteTargetId(null);
    }
  };
```

- [ ] **Step 4: Update the 2 call sites**

Change (currently line 369, inside `renderDesktopActions`):

```typescript
          onClick={() => handleDelete(row.record.id)}
```

to:

```typescript
          onClick={() => handleDeleteClick(row.record.id)}
```

Change (currently line 425, inside `renderMobileActions`):

```typescript
          onClick={() => handleDelete(row.record.id)}
```

to:

```typescript
          onClick={() => handleDeleteClick(row.record.id)}
```

(Both `onClick` props are otherwise identical in the surrounding markup — this is the same rename applied at both call sites.)

- [ ] **Step 5: Wrap the return value and render the modal**

Change the top of the final `return` (currently line 451):

```typescript
  return (
    <div className="space-y-4">
```

to:

```typescript
  return (
    <>
    <div className="space-y-4">
```

Change the end of the component (currently lines 684-687):

```typescript
      </div>
    </div>
  );
}
```

to:

```typescript
      </div>
    </div>

    <ConfirmationModal
      isOpen={isDeleteModalOpen}
      onClose={() => {
        setIsDeleteModalOpen(false);
        setDeleteTargetId(null);
      }}
      onConfirm={handleConfirmDelete}
      title="刪除考勤記錄"
      message="確定要刪除此考勤記錄嗎？此操作無法復原。"
    />
    </>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/AttendanceTable.tsx
git commit -m "fix: replace window.confirm with ConfirmationModal in AttendanceTable"
```

---

### Task 5: Replace static Material Icons in `HistoryPage.tsx`

**Files:**
- Modify: `client/src/pages/HistoryPage.tsx`

- [ ] **Step 1: Extend the lucide-react import**

Change (line 20):

```typescript
import { Archive, Database, Lock, Shield, Upload } from "lucide-react";
```

to:

```typescript
import { Archive, ChevronLeft, ChevronRight, Database, Lock, Search, Shield, Upload } from "lucide-react";
```

- [ ] **Step 2: Replace the search icon**

Change (currently lines 478-480):

```typescript
              <span className="material-icons absolute right-3 top-2.5 text-gray-400">
                search
              </span>
```

to:

```typescript
              <Search className="absolute right-3 top-2.5 h-5 w-5 text-gray-400" />
```

- [ ] **Step 3: Replace the pagination chevrons**

Change (currently line 587):

```typescript
              <span className="material-icons text-sm">chevron_left</span>
```

to:

```typescript
              <ChevronLeft className="h-4 w-4" />
```

Change (currently line 617):

```typescript
              <span className="material-icons text-sm">chevron_right</span>
```

to:

```typescript
              <ChevronRight className="h-4 w-4" />
```

- [ ] **Step 4: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/HistoryPage.tsx
git commit -m "fix: replace Material Icons with lucide-react in HistoryPage"
```

---

### Task 6: Migrate `attendanceSyncStatus.ts`'s icon from a Material Icons name to a Lucide component

**Files:**
- Modify: `client/src/lib/attendanceSyncStatus.ts`
- Modify: `client/src/lib/attendanceSyncStatus.test.ts`

This is the one dynamic case (`AttendancePage.tsx`'s sync badge icon comes from this shared lib, not a static JSX literal), so the icon name string itself needs to become a component reference.

- [ ] **Step 1: Write the failing test**

In `client/src/lib/attendanceSyncStatus.test.ts`, change:

```typescript
import { describe, expect, it } from "vitest";

import {
  createAttendanceSyncStatus,
  getAttendanceSyncBadge,
} from "@/lib/attendanceSyncStatus";

describe("attendance sync status", () => {
  it("maps the locked state to an unlock prompt instead of syncing", () => {
    const badge = getAttendanceSyncBadge(
      createAttendanceSyncStatus("locked", null),
    );

    expect(badge.label).toBe("等待解鎖");
    expect(badge.icon).toBe("lock_clock");
  });
```

to:

```typescript
import { describe, expect, it } from "vitest";
import { Lock } from "lucide-react";

import {
  createAttendanceSyncStatus,
  getAttendanceSyncBadge,
} from "@/lib/attendanceSyncStatus";

describe("attendance sync status", () => {
  it("maps the locked state to an unlock prompt instead of syncing", () => {
    const badge = getAttendanceSyncBadge(
      createAttendanceSyncStatus("locked", null),
    );

    expect(badge.label).toBe("等待解鎖");
    expect(badge.icon).toBe(Lock);
  });
```

(The other two tests in this file don't assert on `.icon`, so they need no change.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/lib/attendanceSyncStatus.test.ts`
Expected: FAIL — `expect(badge.icon).toBe(Lock)` fails because `badge.icon` is still the string `"lock_clock"`.

- [ ] **Step 3: Update the source**

In `client/src/lib/attendanceSyncStatus.ts`, change:

```typescript
export type AttendanceSyncState = "synced" | "syncing" | "locked" | "error";

export type AttendanceSyncStatus = {
  state: AttendanceSyncState;
  synced: boolean;
  lastSynced: string | null;
};

export function createAttendanceSyncStatus(
  state: AttendanceSyncState,
  lastSynced: string | null,
): AttendanceSyncStatus {
  return {
    state,
    synced: state === "synced",
    lastSynced,
  };
}

export function getAttendanceSyncBadge(syncStatus: AttendanceSyncStatus) {
  switch (syncStatus.state) {
    case "locked":
      return {
        icon: "lock_clock",
        label: "等待解鎖",
        tone: "text-gray-500",
        detail: "掃碼站尚未解鎖，公開考勤資料會在解鎖後自動更新。",
      };
    case "error":
      return {
        icon: "sync_problem",
        label: "同步失敗",
        tone: "text-red-600",
        detail: syncStatus.lastSynced
          ? `目前無法更新考勤資料。最後成功同步時間：${syncStatus.lastSynced}`
          : "目前無法更新考勤資料，請稍後再試。",
      };
    case "syncing":
      return {
        icon: "sync",
        label: "同步中...",
        tone: "text-warning",
        detail: "正在與伺服器同步最新考勤資料。",
      };
    case "synced":
    default:
      return {
        icon: "cloud_done",
        label: "資料已同步",
        tone: "text-success",
        detail: `最後同步時間：${syncStatus.lastSynced || "未知"}`,
      };
  }
}
```

to:

```typescript
import { CheckCircle2, Lock, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";

export type AttendanceSyncState = "synced" | "syncing" | "locked" | "error";

export type AttendanceSyncStatus = {
  state: AttendanceSyncState;
  synced: boolean;
  lastSynced: string | null;
};

export type AttendanceSyncBadge = {
  icon: LucideIcon;
  label: string;
  tone: string;
  detail: string;
};

export function createAttendanceSyncStatus(
  state: AttendanceSyncState,
  lastSynced: string | null,
): AttendanceSyncStatus {
  return {
    state,
    synced: state === "synced",
    lastSynced,
  };
}

export function getAttendanceSyncBadge(syncStatus: AttendanceSyncStatus): AttendanceSyncBadge {
  switch (syncStatus.state) {
    case "locked":
      return {
        icon: Lock,
        label: "等待解鎖",
        tone: "text-gray-500",
        detail: "掃碼站尚未解鎖，公開考勤資料會在解鎖後自動更新。",
      };
    case "error":
      return {
        icon: TriangleAlert,
        label: "同步失敗",
        tone: "text-red-600",
        detail: syncStatus.lastSynced
          ? `目前無法更新考勤資料。最後成功同步時間：${syncStatus.lastSynced}`
          : "目前無法更新考勤資料，請稍後再試。",
      };
    case "syncing":
      return {
        icon: RefreshCw,
        label: "同步中...",
        tone: "text-warning",
        detail: "正在與伺服器同步最新考勤資料。",
      };
    case "synced":
    default:
      return {
        icon: CheckCircle2,
        label: "資料已同步",
        tone: "text-success",
        detail: `最後同步時間：${syncStatus.lastSynced || "未知"}`,
      };
  }
}
```

(`cloud_done` has no direct one-icon equivalent in this project's lucide-react version — `CheckCircle2` is used to convey "done/synced" instead of a literal cloud+checkmark glyph.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run client/src/lib/attendanceSyncStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `AttendancePage.tsx` to render the icon component and replace the static "add" icon**

Change the lucide-react import (currently lines 15-22):

```typescript
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Lock,
  Shield,
  UserCheck,
} from "lucide-react";
```

to:

```typescript
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  Shield,
  UserCheck,
} from "lucide-react";
```

Change (currently line 507):

```typescript
              <span className="material-icons text-sm">{syncBadge.icon}</span>
```

to:

```typescript
              <syncBadge.icon className="h-4 w-4" />
```

Change (currently line 738):

```typescript
            <span className="material-icons text-sm mr-1">add</span>
```

to:

```typescript
            <Plus className="mr-1 h-4 w-4" />
```

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/attendanceSyncStatus.ts client/src/lib/attendanceSyncStatus.test.ts client/src/pages/AttendancePage.tsx
git commit -m "fix: replace Material Icons with lucide-react in AttendancePage and attendanceSyncStatus"
```

---

### Task 7: Fix low-contrast `--ink-3` text in `AppShell.tsx`

**Files:**
- Modify: `client/src/components/layout/AppShell.tsx`

`--ink-3` (`#8e948e`) is close to/below WCAG AA 4.5:1 contrast against `--paper` (`#fbfaf6`) for small text. Per the approved design, fix the small-text usages (not the larger nav icons, which are a different contrast category at 3:1). `--ink-2` (`#5e6460`) is the existing, already-used darker token.

- [ ] **Step 1: Fix the mobile bottom-nav inactive item (icon + label together)**

Change (currently lines 121-131, the inactive branch of the bottom nav item):

```typescript
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-center transition-colors",
        isActive
          ? "bg-white text-[var(--sage-deep)] shadow-[0_8px_20px_rgba(42,46,42,0.08)]"
          : "text-[var(--ink-3)] hover:bg-white/70 hover:text-[var(--ink-1)]",
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5",
          isActive ? "text-[var(--sage)]" : "text-[var(--ink-3)]",
        )}
      />
```

to:

```typescript
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-center transition-colors",
        isActive
          ? "bg-white text-[var(--sage-deep)] shadow-[0_8px_20px_rgba(42,46,42,0.08)]"
          : "text-[var(--ink-2)] hover:bg-white/70 hover:text-[var(--ink-1)]",
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5",
          isActive ? "text-[var(--sage)]" : "text-[var(--ink-2)]",
        )}
      />
```

(The sidebar nav item at lines 94-98, a *larger* icon-only color with no attached small text, is left on `--ink-3` — out of scope per the design doc, which scoped this fix to small text.)

- [ ] **Step 2: Fix the collapsed-header brand text and version badge**

Change (currently lines 208-220):

```typescript
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink-3)]">
                {appTitle}
              </p>
              <div className="mt-1 flex items-center gap-2">
```

to:

```typescript
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink-2)]">
                {appTitle}
              </p>
              <div className="mt-1 flex items-center gap-2">
```

Change:

```typescript
                  <span className="shrink-0 rounded-full border border-[var(--line)] bg-white/80 px-2 py-0.5 text-[10px] tracking-[0.16em] text-[var(--ink-3)]">
                    v{appVersion}
                  </span>
```

to:

```typescript
                  <span className="shrink-0 rounded-full border border-[var(--line)] bg-white/80 px-2 py-0.5 text-[10px] tracking-[0.16em] text-[var(--ink-2)]">
                    v{appVersion}
                  </span>
```

- [ ] **Step 3: Fix the mobile footer**

Change (currently line 229):

```typescript
          <footer className="mt-6 pb-2 text-center text-[11px] tracking-[0.14em] text-[var(--ink-3)]">
```

to:

```typescript
          <footer className="mt-6 pb-2 text-center text-[11px] tracking-[0.14em] text-[var(--ink-2)]">
```

- [ ] **Step 4: Fix the desktop sidebar brand subtitle**

Change (currently line 289):

```typescript
                  <div className="mt-1 text-[11px] tracking-[0.18em] text-[var(--ink-3)]">
                    BARCODE · V3
                  </div>
```

to:

```typescript
                  <div className="mt-1 text-[11px] tracking-[0.18em] text-[var(--ink-2)]">
                    BARCODE · V3
                  </div>
```

- [ ] **Step 5: Fix the desktop sidebar section label**

Change (currently line 311):

```typescript
                    <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.24em] text-[var(--ink-3)]">
                      {section.label}
                    </div>
```

to:

```typescript
                    <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.24em] text-[var(--ink-2)]">
                      {section.label}
                    </div>
```

- [ ] **Step 6: Fix the "已登入" admin status text**

Change (currently line 352):

```typescript
                  <div className="text-[11px] tracking-[0.14em] text-[var(--ink-3)]">
                    已登入
                  </div>
```

to:

```typescript
                  <div className="text-[11px] tracking-[0.14em] text-[var(--ink-2)]">
                    已登入
                  </div>
```

- [ ] **Step 7: Fix the collapsed-sidebar header brand text and version badge**

Change (currently lines 377-390):

```typescript
              <div className="min-w-0 flex-1">
                <div className="text-xs tracking-[0.18em] text-[var(--ink-3)]">
                  {appTitle}
                </div>
```

to:

```typescript
              <div className="min-w-0 flex-1">
                <div className="text-xs tracking-[0.18em] text-[var(--ink-2)]">
                  {appTitle}
                </div>
```

Change:

```typescript
              {appVersion ? (
                <div className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs tracking-[0.16em] text-[var(--ink-3)]">
                  v{appVersion}
                </div>
              ) : null}
```

to:

```typescript
              {appVersion ? (
                <div className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs tracking-[0.16em] text-[var(--ink-2)]">
                  v{appVersion}
                </div>
              ) : null}
```

- [ ] **Step 8: Fix the desktop footer**

Change (currently line 398):

```typescript
          <footer className="border-t border-[var(--line-soft)] px-6 py-4 text-center text-xs tracking-[0.16em] text-[var(--ink-3)] xl:px-8">
```

to:

```typescript
          <footer className="border-t border-[var(--line-soft)] px-6 py-4 text-center text-xs tracking-[0.16em] text-[var(--ink-2)] xl:px-8">
```

- [ ] **Step 9: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add client/src/components/layout/AppShell.tsx
git commit -m "fix: raise contrast on small ink-3 text to ink-2 in AppShell"
```

---

### Task 8: Manual verification

**Files:** none (verification only)

This plan is pure UI/markup with no dedicated automated coverage beyond Task 6's unit test, so manual verification is required per the approved design.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Check at mobile width (≤768px) in browser devtools**

- `HistoryTable` and `EmployeesTableCard` mobile card action buttons are visibly taller (44px) than before.
- Deleting an attendance record on `AttendancePage` shows the app's own confirmation dialog (title "刪除考勤記錄"), not a native browser `confirm()` popup.
- The attendance sync badge (top of `AttendancePage`) renders a lucide icon (not raw text like "sync" or "cloud_done") in all 4 states — easiest to check the "syncing" and "synced" states by toggling network conditions or watching it after a save.
- Bottom nav labels and other small text fixed in Task 7 are visibly easier to read against the paper background.

- [ ] **Step 3: Check at desktop width**

- `HistoryTable` and `EmployeesTableCard` desktop table buttons are visually unchanged in size (still their original compact size).
- Hovering the desktop icon-only buttons still shows the same tooltip text as before (from `title`); inspect one with browser devtools' Accessibility pane to confirm it now also reports an accessible name from `aria-label`.
- `HistoryPage`'s search icon and pagination chevrons render as lucide icons, matching the visual weight of icons elsewhere on the page.

- [ ] **Step 4: Record the result**

Note the outcome of Steps 2-3 in the PR description — this plan has no automated end-to-end coverage for the UI-only changes, so this manual pass is the actual verification record.

---

## Self-Review Notes

- **Spec coverage:** All 5 items from the design doc are covered — touch targets (Tasks 1-3), confirm modal (Task 4), aria-labels (Tasks 2-3), icon unification (Tasks 5-6), contrast (Task 7). ✅
- **Placeholder scan:** No TBD/TODO; every step shows full before/after code. ✅
- **Scope discovered during research, now folded into the plan:** the original design doc cited 3-4 `--ink-3` spots as examples and explicitly asked to "grep for other instances and apply the same fix if found" — actual inspection found 10 genuine small-text spots in `AppShell.tsx` (not just the cited ones), all covered in Task 7. The dynamic `syncBadge.icon` case (a string prop, not a static JSX icon) required a small lib-level type change (Task 6) beyond a simple span swap — this was necessary to actually satisfy "全部統一改用 lucide-react" for that spot rather than leaving it half-migrated. ✅
- **Type consistency:** `AttendanceSyncBadge.icon: LucideIcon` (Task 6) is consumed as `<syncBadge.icon className="h-4 w-4" />` in `AttendancePage.tsx` — verified this is valid JSX (rendering a component held in a variable/property requires capitalized-or-dotted access, which `syncBadge.icon` satisfies). ✅
