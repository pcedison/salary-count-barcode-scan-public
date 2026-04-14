import { useState, useEffect, useRef } from 'react';
import { useToast } from "@/hooks/use-toast";
import { useAttendanceData } from '@/hooks/useAttendanceData';
import { useSettings } from '@/hooks/useSettings';
import { useAdmin } from '@/hooks/useAdmin';
import { useEmployees } from '@/hooks/useEmployees';
import type { Employee } from '@/hooks/useEmployees';
import { useQueryClient } from '@tanstack/react-query';
import AttendanceTable from '@/components/AttendanceTable';
import SalaryResultTable from '@/components/SalaryResultTable';
import ConfirmationModal from '@/components/ConfirmationModal';
import AdminLoginDialog from '@/components/AdminLoginDialog';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Button } from '@/components/ui/button';
import { Lock, Shield, User, UserCheck } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { invalidateAttendanceQueries } from '@/lib/attendanceRecords';
import { getAttendanceSyncBadge } from '@/lib/attendanceSyncStatus';
import { debugLog, debugWarn } from '@/lib/debug';
import { getCurrentYearMonth, getMonthName, getTodayDate, getCurrentTime } from '@/lib/utils';
import { eventBus, EventNames } from '@/lib/eventBus';

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
    clearAllData,
    finalizeAndSave
  } = useAttendanceData();

  const { settings } = useSettings({ requireAdminSettings: isAdmin });
  const { activeEmployees, isLoading: isLoadingEmployees, forceRefreshEmployees } = useEmployees();

  // 將員工資料記錄到console，便於調試
  useEffect(() => {
    debugLog('調試員工資料:', {
      活躍員工數: activeEmployees?.length || 0,
      員工列表: activeEmployees?.map(e => `${e.name} (ID: ${e.id})`) || []
    });
  }, [activeEmployees]);

  const [isLoginModalOpen, setIsLoginModalOpen] = useState<boolean>(false);
  const [recentActivity, setRecentActivity] = useState<{ message: string; timestamp: string } | null>(null);

  const [date, setDate] = useState<string>(getTodayDate());
  const [clockIn, setClockIn] = useState<string>('09:00');
  const [clockOut, setClockOut] = useState<string>('18:00');
  const [showSalaryResult, setShowSalaryResult] = useState<boolean>(false);
  const [showConfirmationModal, setShowConfirmationModal] = useState<boolean>(false);

  // 員工選擇相關狀態
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);

  // 過濾特定員工的考勤記錄
  const filteredAttendanceData = (selectedEmployeeId && selectedEmployeeId !== 'all')
    ? attendanceData.filter(record =>
        record.employeeId === parseInt(selectedEmployeeId) ||
        (record._employeeName && selectedEmployee && record._employeeName === selectedEmployee.name)
      )
    : attendanceData;

  const { year, month } = getCurrentYearMonth();
  const syncBadge = getAttendanceSyncBadge(syncStatus);

  // 處理員工選擇變更
  const handleEmployeeChange = (employeeId: string) => {
    debugLog('選擇員工ID:', employeeId);
    setSelectedEmployeeId(employeeId);

    if (employeeId === 'all') {
      setSelectedEmployee(null);
    } else {
      const employee = activeEmployees?.find(emp => emp.id.toString() === employeeId);
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
    const unsubscribeScan = eventBus.on(EventNames.BARCODE_SCANNED, (data: any) => {
      debugLog('條碼掃描事件接收成功:', data);

      // 設置最近活動信息
      setRecentActivity({
        message: `${data.employeeName || '員工'} ${data.action === 'clock-in' ? '上班打卡' : '下班打卡'}`,
        timestamp: new Date().toLocaleTimeString()
      });

      // 立即刷新考勤數據
      invalidateAttendanceQueries(queryClient);

      // 如果有員工姓名，嘗試自動切換到該員工的考勤資料
      if (data.employeeName) {
        const employee = activeEmployees.find(emp => emp.name === data.employeeName);
        if (employee) {
          setSelectedEmployeeId(employee.id.toString());
          setSelectedEmployee(employee);

          toast({
            title: "已自動切換",
            description: `已切換至 ${employee.name} 的考勤記錄`,
          });
        }
      }
    });

    // 訂閱考勤更新事件
    const unsubscribeUpdate = eventBus.on(EventNames.ATTENDANCE_UPDATED, (data: any) => {
      debugLog('考勤更新事件接收成功:', data);
      // 立即刷新考勤數據
      invalidateAttendanceQueries(queryClient);

      // 如果是完整的打卡循環結束，清空最近活動信息
      if (data.complete) {
        setRecentActivity(null);
      }
    });

    // 組件卸載時取消訂閱
    return () => {
      unsubscribeScan();
      unsubscribeUpdate();
    };
  }, [queryClient, activeEmployees, toast]);

  // Calculate and show salary result - 改進版，支持單一員工或多員工模式
  const handleCalculateSalary = () => {
    // 檢查是否有考勤數據可供計算
    if (attendanceData.length === 0) {
      toast({
        title: "無法計算",
        description: "沒有任何考勤記錄，請先新增考勤資料。",
        variant: "destructive"
      });
      return;
    }

    // 選擇特定員工時的處理邏輯
    if (selectedEmployeeId !== 'all' && selectedEmployeeId !== '') {
      // 使用過濾後的特定員工考勤數據
      if (filteredAttendanceData.length === 0) {
        toast({
          title: "無法計算",
          description: `沒有找到 ${selectedEmployee?.name || '所選員工'} 的考勤記錄，請先新增考勤資料。`,
          variant: "destructive"
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
      const employeeIds = Array.from(new Set(attendanceData.map(record => record.employeeId)));

      if (employeeIds.length === 0) {
        toast({
          title: "無法計算",
          description: "沒有包含員工ID的考勤記錄，無法計算薪資。",
          variant: "destructive"
        });
        return;
      }

      if (employeeIds.length > 1) {
        // 多員工模式 - 提示用戶將一次性計算多個員工的薪資
        toast({
          title: "多員工模式",
          description: `將計算 ${employeeIds.length} 名員工的薪資，每位員工會產生獨立的薪資記錄。`,
        });
      }

      try {
        // 計算第一位員工的薪資並顯示結果
        // 注意：finalizeAndSave 函數將處理所有員工的薪資結算
        const firstEmployeeId = employeeIds[0];

        if (!firstEmployeeId) {
          throw new Error("無法獲取有效的員工ID");
        }

        const firstEmployeeData = attendanceData.filter(record => record.employeeId === firstEmployeeId);

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
          description: error instanceof Error ? error.message : "無法計算薪資，請確認考勤數據是否完整",
          variant: "destructive"
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
        variant: "destructive"
      });
      return;
    }

    if (!selectedEmployee) {
      toast({
        title: "請先選擇員工",
        description: "請在員工選擇器中選擇一位員工，再新增考勤記錄。",
        variant: "destructive"
      });
      return;
    }

    addAttendance({
      employeeId: selectedEmployee.id,
      date,
      clockIn,
      clockOut,
      isHoliday: false
    });

    // Reset clock in/out times but keep the date for consecutive entries
    setClockIn('09:00');
    setClockOut('18:00');

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
        variant: "destructive"
      });
      setShowConfirmationModal(false);
      setIsLoginModalOpen(true);
      return;
    }

    setShowConfirmationModal(false);

    // 等待結算完成並獲取結果
    const success = await finalizeAndSave();

    if (success) {
      setShowSalaryResult(false);
      toast({
        title: "結算完成",
        description: "考勤資料已結算並儲存至歷史紀錄。",
      });
    }
    // 失敗的情況在 finalizeAndSave 內部已經處理了 toast
  };

  // Handle print event
  // 不再需要頂部按鈕的事件監聽器，因為按鈕已經被移除

  return (
    <div className="space-y-6">
      {/* Input Section */}
      <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
        <h2 className="text-lg font-medium mb-4">新增考勤紀錄</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2">
            <label htmlFor="date" className="block text-sm font-medium text-gray-700">日期</label>
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
            <label htmlFor="clockIn" className="block text-sm font-medium text-gray-700">上班時間</label>
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
            <label htmlFor="clockOut" className="block text-sm font-medium text-gray-700">下班時間</label>
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
        <div className="mt-4 flex justify-end">
          <Button
            onClick={handleAddAttendance}
            disabled={!selectedEmployee || !isAdmin}
            className="bg-primary hover:bg-blue-700 text-white px-6 py-2 rounded-md flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-icons text-sm mr-1">add</span>
            {selectedEmployee ? '新增' : '請先選擇員工'}
          </Button>
        </div>
      </div>

      {/* Month Title and Calculate Button */}
      {/* 員工選擇區塊 */}
      <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <UserCheck className="text-blue-600" />
            <h3 className="font-medium text-blue-800">查看員工考勤記錄</h3>
          </div>

          {selectedEmployee && (
            <div className="text-sm text-blue-700 bg-blue-100 px-3 py-1 rounded-full">
              當前員工: {selectedEmployee.name}
              {selectedEmployee.department ? ` (${selectedEmployee.department})` : ''}
            </div>
          )}
        </div>

        <div className="mt-3">
          <Select
            value={selectedEmployeeId}
            onValueChange={handleEmployeeChange}
            disabled={isLoadingEmployees}
          >
            <SelectTrigger className="w-full bg-white">
              <SelectValue placeholder={isLoadingEmployees ? "加載員工資料中..." : "選擇要查看的員工..."} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部員工</SelectItem>
              {activeEmployees && activeEmployees.length > 0 && (
                activeEmployees.map((employee) => (
                  <SelectItem key={employee.id} value={employee.id.toString()}>
                    {employee.name} {employee.department ? `(${employee.department})` : ''}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>


          <div className="flex justify-end mt-2">
            <button
              className="text-xs text-gray-500 hover:text-blue-600"
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
                    .catch(error => {
                      toast({
                        title: "更新失敗",
                        description: `載入員工資料時發生錯誤: ${error.message}`,
                        variant: "destructive",
                      });
                    });
                }
              }}
            >
              <span className="underline">重新載入員工資料</span>
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold">
            {attendanceData.length > 0
              ? `${attendanceData[0].date.split('/')[0]}年${getMonthName(parseInt(attendanceData[0].date.split('/')[1]))}考勤打卡`
              : `${year}年${getMonthName(month)}考勤打卡`}
          </h2>

          {/* 最近打卡活動提示 */}
          {recentActivity && (
            <div className="mt-1 text-sm text-primary animate-pulse flex items-center">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
              {recentActivity.message} ({recentActivity.timestamp})
            </div>
          )}
        </div>
        <div className="flex items-center space-x-3">
          {isAdmin ? (
            <div className="bg-primary/10 px-3 py-1 rounded-full text-primary text-sm font-medium flex items-center mr-2">
              <Shield className="w-4 h-4 mr-1" />
              管理員模式
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsLoginModalOpen(true)}
              className="text-gray-500 mr-2"
            >
              <Lock className="w-4 h-4 mr-1" />
              管理員登入
            </Button>
          )}
          <div className="relative">
            <button
              className={`bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded-md text-sm flex items-center ${syncBadge.tone}`}
              title={syncBadge.detail}
              type="button"
            >
              <span className="material-icons text-sm mr-1">{syncBadge.icon}</span>
              {syncBadge.label}
            </button>
            {/* Sync Status Tooltip - can be enhanced with hover state */}
            <div className="hidden absolute top-full right-0 mt-2 w-64 bg-white p-3 rounded-md shadow-lg z-10 text-sm">
              {syncBadge.detail}
            </div>
          </div>
          {/* 只在管理員模式下顯示計算薪資按鈕 */}
          {isAdmin && (
            <Button
              onClick={handleCalculateSalary}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md"
            >
              計算薪資
            </Button>
          )}
        </div>
      </div>

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
        message="您確定要結算並清除所有考勤紀錄嗎？此操作無法復原。"
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
