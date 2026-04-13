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
