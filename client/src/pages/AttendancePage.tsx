import { useState, useEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAttendanceData } from "@/hooks/useAttendanceData";
import { useSettings } from "@/hooks/useSettings";
import { useAdmin } from "@/hooks/useAdmin";
import { useEmployees } from "@/hooks/useEmployees";
import type { Employee } from "@/hooks/useEmployees";
import { useQueryClient } from "@tanstack/react-query";
import AttendanceTable from "@/components/AttendanceTable";
import SalaryResultTable from "@/components/SalaryResultTable";
import ConfirmationModal from "@/components/ConfirmationModal";
import AdminLoginDialog from "@/components/AdminLoginDialog";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Button } from "@/components/ui/button";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  Shield,
  UserCheck,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { invalidateAttendanceQueries } from "@/lib/attendanceRecords";
import { getAttendanceSyncBadge } from "@/lib/attendanceSyncStatus";
import { debugLog, debugWarn } from "@/lib/debug";
import { getCurrentYearMonth, getMonthName, getTodayDate } from "@/lib/utils";
import { eventBus, EventNames } from "@/lib/eventBus";

function toMonthKey(dateValue: string): string | null {
  if (!dateValue) return null;

  const [yearValue, monthValue] = dateValue.replace(/-/g, "/").split("/");
  const year = Number(yearValue);
  const month = Number(monthValue);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}`;
}

function toMonthLabel(monthKey: string): string {
  const [yearValue, monthValue] = monthKey.split("-");
  const year = Number(yearValue);
  const month = Number(monthValue);

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return monthKey;
  }

  return `${year}年${getMonthName(month)}`;
}

function shiftMonthKey(monthKey: string, offset: number): string {
  const [yearValue, monthValue] = monthKey.split("-");
  const date = new Date(Number(yearValue), Number(monthValue) - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthSortValue(monthKey: string): number {
  const [yearValue, monthValue] = monthKey.split("-");
  return Number(yearValue) * 12 + Number(monthValue);
}

export default function AttendancePage() {
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const queryClient = useQueryClient();
  const {
    attendanceData,
    isLoading,
    addAttendance,
    updateAttendance,
    deleteAttendance,
    syncStatus,
    calculateSalary,
    salaryResult,
    finalizeAndSave,
  } = useAttendanceData();

  const { settings } = useSettings({ requireAdminSettings: isAdmin });
  const {
    activeEmployees,
    isLoading: isLoadingEmployees,
    forceRefreshEmployees,
  } = useEmployees();

  // 將員工資料記錄到console，便於調試
  useEffect(() => {
    debugLog("調試員工資料:", {
      活躍員工數: activeEmployees?.length || 0,
      員工列表: activeEmployees?.map((e) => `${e.name} (ID: ${e.id})`) || [],
    });
  }, [activeEmployees]);

  const [isLoginModalOpen, setIsLoginModalOpen] = useState<boolean>(false);
  const [recentActivity, setRecentActivity] = useState<{
    message: string;
    timestamp: string;
  } | null>(null);

  const [date, setDate] = useState<string>(getTodayDate());
  const [clockIn, setClockIn] = useState<string>("09:00");
  const [clockOut, setClockOut] = useState<string>("18:00");
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>(
    toMonthKey(getTodayDate()) || "",
  );
  const [showSalaryResult, setShowSalaryResult] = useState<boolean>(false);
  const [showConfirmationModal, setShowConfirmationModal] =
    useState<boolean>(false);

  // 員工選擇相關狀態
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(
    null,
  );

  const attendanceMonthOptions = useMemo(() => {
    const summaries = new Map<
      string,
      {
        value: string;
        label: string;
        recordCount: number;
        employeeIds: Set<number>;
      }
    >();

    const ensureSummary = (monthKey: string) => {
      if (!summaries.has(monthKey)) {
        summaries.set(monthKey, {
          value: monthKey,
          label: toMonthLabel(monthKey),
          recordCount: 0,
          employeeIds: new Set<number>(),
        });
      }

      return summaries.get(monthKey)!;
    };

    attendanceData.forEach((record) => {
      const monthKey = toMonthKey(record.date);
      if (!monthKey) return;

      const summary = ensureSummary(monthKey);
      summary.recordCount += 1;

      if (record.employeeId) {
        summary.employeeIds.add(record.employeeId);
      }
    });

    [selectedMonthKey, toMonthKey(getTodayDate()), toMonthKey(date)]
      .filter((monthKey): monthKey is string => Boolean(monthKey))
      .forEach(ensureSummary);

    return Array.from(summaries.values())
      .sort((a, b) => monthSortValue(b.value) - monthSortValue(a.value))
      .map((summary) => ({
        value: summary.value,
        label: summary.label,
        recordCount: summary.recordCount,
        employeeCount: summary.employeeIds.size,
      }));
  }, [attendanceData, date, selectedMonthKey]);

  const selectedMonthAttendanceData = useMemo(
    () =>
      attendanceData.filter(
        (record) => toMonthKey(record.date) === selectedMonthKey,
      ),
    [attendanceData, selectedMonthKey],
  );

  const selectedMonthSummary = attendanceMonthOptions.find(
    (option) => option.value === selectedMonthKey,
  );
  const selectedMonthLabel = selectedMonthSummary?.label || toMonthLabel(selectedMonthKey);
  const hiddenOtherMonthRecordCount =
    attendanceData.length - selectedMonthAttendanceData.length;

  // 先依月份切分，再過濾特定員工的考勤記錄
  const filteredAttendanceData = useMemo(
    () =>
      selectedEmployeeId && selectedEmployeeId !== "all"
        ? selectedMonthAttendanceData.filter(
          (record) =>
            record.employeeId === parseInt(selectedEmployeeId) ||
            (record._employeeName &&
              selectedEmployee &&
              record._employeeName === selectedEmployee.name),
        )
        : selectedMonthAttendanceData,
    [selectedEmployee, selectedEmployeeId, selectedMonthAttendanceData],
  );

  const { year, month } = getCurrentYearMonth();
  const syncBadge = getAttendanceSyncBadge(syncStatus);
  const attendanceHeading = selectedMonthKey
    ? `${selectedMonthLabel}考勤打卡`
    : `${year}年${getMonthName(month)}考勤打卡`;

  useEffect(() => {
    setShowSalaryResult(false);
  }, [selectedEmployeeId, selectedMonthKey]);

  // 處理員工選擇變更
  const handleEmployeeChange = (employeeId: string) => {
    debugLog("選擇員工ID:", employeeId);
    setSelectedEmployeeId(employeeId);

    if (employeeId === "all") {
      setSelectedEmployee(null);
    } else {
      const employee = activeEmployees?.find(
        (emp) => emp.id.toString() === employeeId,
      );
      if (employee) {
        setSelectedEmployee(employee);
      } else {
        debugWarn(`找不到ID為 ${employeeId} 的員工資料`);
      }
    }
  };

  // 監聽打卡事件，當有新打卡時立即刷新數據
  useEffect(() => {
    // 訂閱條碼掃描事件
    const unsubscribeScan = eventBus.on(
      EventNames.BARCODE_SCANNED,
      (data: any) => {
        debugLog("條碼掃描事件接收成功:", data);

        // 設置最近活動信息
        setRecentActivity({
          message: `${data.employeeName || "員工"} ${data.action === "clock-in" ? "上班打卡" : "下班打卡"}`,
          timestamp: new Date().toLocaleTimeString(),
        });

        // 立即刷新考勤數據
        invalidateAttendanceQueries(queryClient);

        const scannedRecordMonth = toMonthKey(data.attendance?.date || "");
        if (scannedRecordMonth) {
          setSelectedMonthKey(scannedRecordMonth);
        }

        // 如果有員工姓名，嘗試自動切換到該員工的考勤資料
        if (data.employeeName) {
          const employee = activeEmployees.find(
            (emp) => emp.name === data.employeeName,
          );
          if (employee) {
            setSelectedEmployeeId(employee.id.toString());
            setSelectedEmployee(employee);

            toast({
              title: "已自動切換",
              description: `已切換至 ${employee.name} 的考勤記錄`,
            });
          }
        }
      },
    );

    // 訂閱考勤更新事件
    const unsubscribeUpdate = eventBus.on(
      EventNames.ATTENDANCE_UPDATED,
      (data: any) => {
        debugLog("考勤更新事件接收成功:", data);
        // 立即刷新考勤數據
        invalidateAttendanceQueries(queryClient);

        // 如果是完整的打卡循環結束，清空最近活動信息
        if (data.complete) {
          setRecentActivity(null);
        }
      },
    );

    // 組件卸載時取消訂閱
    return () => {
      unsubscribeScan();
      unsubscribeUpdate();
    };
  }, [queryClient, activeEmployees, toast]);

  // Calculate and show salary result - 改進版，支持單一員工或多員工模式
  const handleCalculateSalary = () => {
    // 檢查是否有考勤數據可供計算
    if (filteredAttendanceData.length === 0) {
      toast({
        title: "無法計算",
        description: `${selectedMonthLabel}沒有可結算的考勤記錄。`,
        variant: "destructive",
      });
      return;
    }

    // 選擇特定員工時的處理邏輯
    if (selectedEmployeeId !== "all" && selectedEmployeeId !== "") {
      // 使用過濾後的特定員工考勤數據
      if (filteredAttendanceData.length === 0) {
        toast({
          title: "無法計算",
          description: `沒有找到 ${selectedEmployee?.name || "所選員工"} 的考勤記錄，請先新增考勤資料。`,
          variant: "destructive",
        });
        return;
      }

      // 計算特定員工的薪資
      const result = calculateSalary(filteredAttendanceData);
      if (result) {
        setShowSalaryResult(true);
      }
    }
    // 選擇"全部員工"時的處理邏輯
    else {
      // 分組員工ID
      const employeeIds = Array.from(
        new Set(
          filteredAttendanceData
            .map((record) => record.employeeId)
            .filter((employeeId): employeeId is number => Boolean(employeeId)),
        ),
      );

      if (employeeIds.length === 0) {
        toast({
          title: "無法計算",
          description: "沒有包含員工ID的考勤記錄，無法計算薪資。",
          variant: "destructive",
        });
        return;
      }

      if (employeeIds.length > 1) {
        // 多員工模式 - 提示用戶將一次性計算多個員工的薪資
        toast({
          title: "多員工模式",
          description: `${selectedMonthLabel}將計算 ${employeeIds.length} 名員工的薪資，每位員工會產生獨立的薪資記錄。`,
        });
      }

      try {
        // 計算第一位員工的薪資並顯示結果
        // 注意：finalizeAndSave 函數將處理所有員工的薪資結算
        const firstEmployeeId = employeeIds[0];

        if (!firstEmployeeId) {
          throw new Error("無法獲取有效的員工ID");
        }

        const firstEmployeeData = filteredAttendanceData.filter(
          (record) => record.employeeId === firstEmployeeId,
        );

        if (firstEmployeeData.length === 0) {
          throw new Error(`ID為 ${firstEmployeeId} 的員工沒有完整考勤記錄`);
        }

        const result = calculateSalary(firstEmployeeData);

        if (result) {
          // 在這裡設置一個標記，表示這是"全部員工"模式
          setShowSalaryResult(true);
        }
      } catch (error) {
        console.error("計算薪資出錯:", error);
        toast({
          title: "計算錯誤",
          description:
            error instanceof Error
              ? error.message
              : "無法計算薪資，請確認考勤數據是否完整",
          variant: "destructive",
        });
        return;
      }
    }
  };

  // Add a new attendance record
  const handleAddAttendance = () => {
    if (!date || !clockIn || !clockOut) {
      toast({
        title: "資料不完整",
        description: "請填寫完整的日期、上班時間和下班時間。",
        variant: "destructive",
      });
      return;
    }

    if (!selectedEmployee) {
      toast({
        title: "請先選擇員工",
        description: "請在員工選擇器中選擇一位員工，再新增考勤記錄。",
        variant: "destructive",
      });
      return;
    }

    addAttendance({
      employeeId: selectedEmployee.id,
      date,
      clockIn,
      clockOut,
      isHoliday: false,
    });

    // Reset clock in/out times but keep the date for consecutive entries
    setClockIn("09:00");
    setClockOut("18:00");

    const newRecordMonth = toMonthKey(date);
    if (newRecordMonth) {
      setSelectedMonthKey(newRecordMonth);
    }

    toast({
      title: "已新增",
      description: "考勤記錄已成功新增。",
    });
  };

  // Handle finalize and save
  const handleFinalize = async () => {
    if (!isAdmin) {
      toast({
        title: "需要管理員權限",
        description: "薪資結算需要管理員權限",
        variant: "destructive",
      });
      setShowConfirmationModal(false);
      setIsLoginModalOpen(true);
      return;
    }

    setShowConfirmationModal(false);

    // 等待結算完成並獲取結果
    const success = await finalizeAndSave(filteredAttendanceData);

    if (success) {
      setShowSalaryResult(false);
      toast({
        title: "結算完成",
        description: `${selectedMonthLabel}考勤資料已結算並儲存至歷史紀錄。`,
      });
    }
    // 失敗的情況在 finalizeAndSave 內部已經處理了 toast
  };

  // Handle print event
  // 不再需要頂部按鈕的事件監聽器，因為按鈕已經被移除

  return (
    <div className="page-stack">
      <section className="page-panel-muted">
        <div className="page-header">
          <div className="page-header-copy">
            <h2 className="page-title">{attendanceHeading}</h2>

            {recentActivity && (
              <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                <span className="truncate">
                  {recentActivity.message} ({recentActivity.timestamp})
                </span>
              </div>
            )}
          </div>

          <div className="page-actions">
            {isAdmin ? (
              <div className="page-badge page-badge-primary">
                <Shield className="h-4 w-4" />
                管理員模式
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsLoginModalOpen(true)}
                className="w-full justify-center text-gray-500 sm:w-auto"
              >
                <Lock className="mr-1 h-4 w-4" />
                管理員登入
              </Button>
            )}

            <button
              className={`page-badge page-badge-muted w-full justify-center sm:w-auto ${syncBadge.tone}`}
              title={syncBadge.detail}
              type="button"
            >
              <syncBadge.icon className="h-4 w-4" />
              {syncBadge.label}
            </button>

            {isAdmin && (
              <Button
                onClick={handleCalculateSalary}
                className="w-full bg-red-600 text-white hover:bg-red-700 sm:w-auto"
              >
                計算薪資
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-primary shadow-sm">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-500">顯示月份</div>
              <div className="truncate text-base font-semibold text-slate-900">
                {selectedMonthLabel}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:min-w-[34rem]">
            <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="上一個月"
                aria-label="上一個月"
                onClick={() => setSelectedMonthKey((current) => shiftMonthKey(current, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <Select value={selectedMonthKey} onValueChange={setSelectedMonthKey}>
                <SelectTrigger className="w-full bg-white">
                  <SelectValue placeholder="選擇月份" />
                </SelectTrigger>
                <SelectContent>
                  {attendanceMonthOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                      {option.recordCount > 0 ? ` (${option.recordCount} 筆)` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="icon"
                title="下一個月"
                aria-label="下一個月"
                onClick={() => setSelectedMonthKey((current) => shiftMonthKey(current, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 text-xs font-medium text-slate-600 sm:justify-end">
              <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                {selectedMonthSummary?.recordCount || 0} 筆紀錄
              </span>
              <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                {selectedMonthSummary?.employeeCount || 0} 名員工
              </span>
              {hiddenOtherMonthRecordCount > 0 && (
                <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700 shadow-sm">
                  其他月份 {hiddenOtherMonthRecordCount} 筆
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="page-panel-accent">
        <div className="page-header">
          <div className="page-header-copy">
            <div className="flex items-center gap-2 text-sky-800">
              <UserCheck className="h-5 w-5" />
              <h3 className="text-base font-medium">查看員工考勤記錄</h3>
            </div>
          </div>

          {selectedEmployee && (
            <div className="page-badge page-badge-accent max-w-full">
              <span className="truncate">
                當前員工: {selectedEmployee.name}
                {selectedEmployee.department
                  ? ` (${selectedEmployee.department})`
                  : ""}
              </span>
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <Select
              value={selectedEmployeeId}
              onValueChange={handleEmployeeChange}
              disabled={isLoadingEmployees}
            >
              <SelectTrigger className="w-full bg-white">
                <SelectValue
                  placeholder={
                    isLoadingEmployees
                      ? "加載員工資料中..."
                      : "選擇要查看的員工..."
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部員工</SelectItem>
                {activeEmployees &&
                  activeEmployees.length > 0 &&
                  activeEmployees.map((employee) => (
                    <SelectItem
                      key={employee.id}
                      value={employee.id.toString()}
                    >
                      {employee.name}{" "}
                      {employee.department ? `(${employee.department})` : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="page-button-row sm:justify-start">
            <button
              className="text-xs font-medium text-sky-700 underline underline-offset-4 hover:text-sky-800"
              onClick={(e) => {
                e.preventDefault();
                if (forceRefreshEmployees) {
                  forceRefreshEmployees()
                    .then(() => {
                      toast({
                        title: "員工資料已更新",
                        description: "員工資料已成功重新載入",
                        variant: "default",
                      });
                    })
                    .catch((error) => {
                      toast({
                        title: "更新失敗",
                        description: `載入員工資料時發生錯誤: ${error.message}`,
                        variant: "destructive",
                      });
                    });
                }
              }}
            >
              重新載入員工資料
            </button>
          </div>
        </div>
      </section>

      <section className="page-panel">
        <h3 className="text-lg font-medium text-slate-900">新增考勤紀錄</h3>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2">
            <label
              htmlFor="date"
              className="block text-sm font-medium text-gray-700"
            >
              日期
            </label>
            <div className="relative">
              <DateTimePicker
                mode="date"
                value={date}
                onChange={setDate}
                placeholder="選擇日期..."
                className="w-full"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="clockIn"
              className="block text-sm font-medium text-gray-700"
            >
              上班時間
            </label>
            <div className="relative">
              <DateTimePicker
                mode="time"
                value={clockIn}
                onChange={setClockIn}
                placeholder="選擇時間..."
                className="w-full"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="clockOut"
              className="block text-sm font-medium text-gray-700"
            >
              下班時間
            </label>
            <div className="relative">
              <DateTimePicker
                mode="time"
                value={clockOut}
                onChange={setClockOut}
                placeholder="選擇時間..."
                className="w-full"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 page-button-row">
          <Button
            onClick={handleAddAttendance}
            disabled={!selectedEmployee || !isAdmin}
            className="flex w-full items-center justify-center bg-primary px-6 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            <Plus className="mr-1 h-4 w-4" />
            {selectedEmployee ? "新增" : "請先選擇員工"}
          </Button>
        </div>
      </section>

      {/* Attendance Data Table */}
      <AttendanceTable
        data={filteredAttendanceData}
        isLoading={isLoading}
        canEdit={isAdmin}
        onUpdateAttendance={updateAttendance}
        onDeleteAttendance={deleteAttendance}
      />
      {/* Salary Result Table */}
      {showSalaryResult && salaryResult && (
        <SalaryResultTable
          result={salaryResult}
          settings={settings}
          onFinalize={() => setShowConfirmationModal(true)}
        />
      )}

      {/* Confirmation Modal */}
      <ConfirmationModal
        isOpen={showConfirmationModal}
        onClose={() => setShowConfirmationModal(false)}
        onConfirm={handleFinalize}
        title="確認操作"
        message={`您確定要結算並清除 ${selectedMonthLabel} 的考勤紀錄嗎？其他月份的未結算紀錄會保留。此操作無法復原。`}
      />

      {/* Admin Login Dialog */}
      <AdminLoginDialog
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onSuccess={() => {
          setIsLoginModalOpen(false);
          toast({
            title: "管理員驗證成功",
            description: "您已進入管理員模式，可以進行薪資結算操作。",
          });
        }}
        title="需要管理員權限"
        description="薪資結算需要管理員權限。請輸入管理員PIN碼進行驗證。"
      />
    </div>
  );
}
