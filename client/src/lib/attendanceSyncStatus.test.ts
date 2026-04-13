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

  it("keeps synced state marked as synced", () => {
    const status = createAttendanceSyncStatus("synced", "2026/04/14 07:10:00");

    expect(status.synced).toBe(true);
    expect(getAttendanceSyncBadge(status).label).toBe("資料已同步");
  });

  it("preserves the last successful sync time for errors", () => {
    const badge = getAttendanceSyncBadge(
      createAttendanceSyncStatus("error", "2026/04/14 07:10:00"),
    );

    expect(badge.label).toBe("同步失敗");
    expect(badge.detail).toContain("最後成功同步時間");
  });
});
