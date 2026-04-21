import { useEffect, useState } from "react";
import { useHistoryData } from "@/hooks/useHistoryData";
import { useAdmin } from "@/hooks/useAdmin";
import { useEmployees } from "@/hooks/useEmployees";
import HistoryTable from "@/components/HistoryTable";
import ConfirmationModal from "@/components/ConfirmationModal";
import AdminLoginDialog from "@/components/AdminLoginDialog";
import EditHistoryRecordModal from "@/components/EditHistoryRecordModal";
import { CsvImportModal } from "@/components/CsvImportModal";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Archive, Database, Lock, Shield, Upload } from "lucide-react";
import JSZip from "jszip";
import { debugLog } from "@/lib/debug";

export default function HistoryPage() {
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const {
    salaryRecords,
    isLoading,
    refetch,
    deleteSalaryRecord,
    updateSalaryRecord,
    exportSalaryRecordAsCsv,
    isDeletingRecord,
    isUpdatingRecord,
  } = useHistoryData();

  const { activeEmployees, isLoading: isLoadingEmployees } = useEmployees();

  const [searchTerm, setSearchTerm] = useState<string>("");
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [recordToDelete, setRecordToDelete] = useState<number | null>(null);
  const [recordToEdit, setRecordToEdit] = useState<any>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState<boolean>(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<number[]>([]);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);

  // Available years for filtering
  const availableYears = Array.from(
    new Set(salaryRecords.map((record) => record.salaryYear)),
  ).sort((a, b) => b - a);

  // 從考勤數據中提取員工ID
  const getEmployeeIdsFromAttendanceData = (
    attendanceData: any[],
  ): number[] => {
    if (!attendanceData || !Array.isArray(attendanceData)) return [];

    // 從考勤數據中提取所有員工ID
    return Array.from(
      new Set(
        attendanceData
          .map((entry) => entry.employeeId)
          .filter((id) => id !== undefined),
      ),
    );
  };

  // Filter records based on search term, year, and employee
  const filteredRecords = salaryRecords.filter((record) => {
    const matchesSearch =
      searchTerm === "" ||
      `${record.salaryYear}年${record.salaryMonth}月`.includes(searchTerm);

    const matchesYear =
      yearFilter === "all" || record.salaryYear.toString() === yearFilter;

    // 員工篩選邏輯 - 改進以處理直接在薪資記錄上的員工ID
    const matchesEmployee =
      employeeFilter === "all" ||
      // 檢查薪資記錄是否直接包含員工ID
      (record as any).employeeId === parseInt(employeeFilter) ||
      // 如果沒有，則檢查考勤數據中的員工ID
      (record.attendanceData &&
        Array.isArray(record.attendanceData) &&
        getEmployeeIdsFromAttendanceData(record.attendanceData).includes(
          parseInt(employeeFilter),
        ));

    return matchesSearch && matchesYear && matchesEmployee;
  });

  // Pagination
  const recordsPerPage = 10;
  const totalPages = Math.max(
    1,
    Math.ceil(filteredRecords.length / recordsPerPage),
  );
  const effectiveCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (effectiveCurrentPage - 1) * recordsPerPage;
  const paginatedRecords = filteredRecords.slice(
    startIndex,
    startIndex + recordsPerPage,
  );
  const hasFilteredRecords = filteredRecords.length > 0;
  const visibleStart = hasFilteredRecords ? startIndex + 1 : 0;
  const visibleEnd = hasFilteredRecords
    ? Math.min(startIndex + recordsPerPage, filteredRecords.length)
    : 0;
  const pageWindowStart = Math.max(
    1,
    Math.min(effectiveCurrentPage - 2, totalPages - 4),
  );
  const pageNumbers = Array.from(
    { length: Math.min(totalPages, 5) },
    (_, index) => pageWindowStart + index,
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, yearFilter, employeeFilter]);

  useEffect(() => {
    setCurrentPage((prev) => Math.min(prev, totalPages));
  }, [totalPages]);

  // 已移除查看詳情功能

  // CSV下載功能 - 使用正確的exportSalaryRecordAsCsv函數
  const handleDownloadPdf = (record: any) => {
    debugLog("Downloading CSV for record:", record);

    // 調用真正的CSV下載功能
    exportSalaryRecordAsCsv(record);
  };

  // Handle delete record confirmation
  const handleDeleteClick = (id: number) => {
    if (!isAdmin) {
      toast({
        title: "需要管理員權限",
        description: "刪除紀錄需要管理員權限",
        variant: "destructive",
      });
      setIsLoginModalOpen(true);
      return;
    }

    setRecordToDelete(id);
    setIsDeleteModalOpen(true);
  };

  // Handle confirm delete
  const handleConfirmDelete = async () => {
    if (recordToDelete) {
      try {
        await deleteSalaryRecord(recordToDelete);
        setIsDeleteModalOpen(false);
        setRecordToDelete(null);

        // If the current page becomes empty after deletion, go back to the previous page
        if (paginatedRecords.length === 1 && currentPage > 1) {
          setCurrentPage(currentPage - 1);
        }
      } catch (error) {
        console.error("Error deleting record:", error);
        toast({
          title: "刪除失敗",
          description: "無法刪除薪資紀錄，請稍後再試",
          variant: "destructive",
        });
      }
    }
  };

  // 處理編輯歷史紀錄（直接在歷史記錄頁面編輯，不需恢復到考勤頁面）
  const handleEditClick = (record: any) => {
    if (!isAdmin) {
      toast({
        title: "需要管理員權限",
        description: "編輯歷史紀錄需要管理員權限",
        variant: "destructive",
      });
      setIsLoginModalOpen(true);
      return;
    }

    // 設置要編輯的記錄並打開編輯對話框
    // 支援有考勤數據和無考勤數據的紀錄編輯
    setRecordToEdit(record);
    setIsEditModalOpen(true);
  };

  // 保存編輯的歷史記錄 - 支援編輯所有欄位
  const handleSaveEditedRecord = async (id: number, updatedData: any) => {
    try {
      // 更新所有可編輯欄位
      await updateSalaryRecord(id, updatedData);

      toast({
        title: "更新成功",
        description: "薪資紀錄已成功更新",
      });

      // 重置狀態
      setIsEditModalOpen(false);
      setRecordToEdit(null);
    } catch (error) {
      console.error("Error updating record:", error);
      toast({
        title: "更新失敗",
        description: "無法更新薪資紀錄，請稍後再試",
        variant: "destructive",
      });
    }
  };

  // 處理選擇/取消選擇記錄
  const handleSelectRecord = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedRecordIds((prev) => [...prev, id]);
    } else {
      setSelectedRecordIds((prev) =>
        prev.filter((recordId) => recordId !== id),
      );
    }
  };

  // 處理全選/取消全選
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedRecordIds(paginatedRecords.map((record) => record.id));
    } else {
      setSelectedRecordIds([]);
    }
  };

  // 批量下載選定的記錄為ZIP文件
  const handleBatchDownloadAsZip = async () => {
    if (selectedRecordIds.length === 0) {
      toast({
        title: "未選擇記錄",
        description: "請先選擇至少一筆薪資記錄進行下載。",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsExportingZip(true);

      // 創建新的ZIP檔案
      const zip = new JSZip();

      // 獲取選中的記錄
      const selectedRecords = salaryRecords.filter((record) =>
        selectedRecordIds.includes(record.id),
      );

      // 為每個選中的記錄創建CSV內容
      const exportPromises = selectedRecords.map(async (record) => {
        try {
          // 考勤數據CSV (基本版)
          let attendanceCsvContent =
            "日期,上班時間,下班時間,工作小時,第一階段加班,第二階段加班,加班費\n";

          // 詳細薪資資料CSV (完整版)
          let fullRecordCsvContent = `薪資年份,薪資月份,基本底薪,住宿津貼,福利津貼,加班總時數OT1,加班總時數OT2,加班總費用,假日天數,假日單日薪資,假日總薪資,總薪資,總扣除額,實領金額\n`;
          fullRecordCsvContent += `${record.salaryYear},${record.salaryMonth},${record.baseSalary},${record.housingAllowance || 0},${record.welfareAllowance || 0},${record.totalOT1Hours},${record.totalOT2Hours},${record.totalOvertimePay},${record.holidayDays},${record.holidayDailySalary},${record.totalHolidayPay},${record.grossSalary},${record.totalDeductions},${record.netSalary}\n\n`;

          // 添加扣除項
          fullRecordCsvContent += "扣除項目,金額\n";
          if (record.deductions && Array.isArray(record.deductions)) {
            record.deductions.forEach((deduction) => {
              fullRecordCsvContent += `${deduction.name},${deduction.amount}\n`;
            });
          }

          fullRecordCsvContent +=
            "\n考勤詳細記錄:\n日期,上班時間,下班時間,是否假日,總工作時數,OT1時數,OT2時數,加班費用\n";

          // 計算每條記錄的加班詳情
          if (record.attendanceData && Array.isArray(record.attendanceData)) {
            record.attendanceData.forEach((attendance) => {
              // 計算總工作時數
              const [inHours, inMinutes] = attendance.clockIn
                .split(":")
                .map(Number);
              const [outHours, outMinutes] = attendance.clockOut
                .split(":")
                .map(Number);
              let totalMinutes =
                outHours * 60 + outMinutes - (inHours * 60 + inMinutes);
              if (totalMinutes < 0) totalMinutes += 24 * 60;
              const totalHours = (totalMinutes / 60).toFixed(1);

              // 假設計算OT1和OT2
              const baseHourlyRate = 119; // 基本時薪
              const ot1HourlyRate = baseHourlyRate * 1.34;
              const ot2HourlyRate = baseHourlyRate * 1.67;
              const ot1 = Math.max(0, totalMinutes / 60 - 8);
              const ot2 = Math.max(0, totalMinutes / 60 - 10);
              const overtimePay =
                ot1 * ot1HourlyRate + ot2 * (ot2HourlyRate - ot1HourlyRate);

              attendanceCsvContent += `${attendance.date},${attendance.clockIn},${attendance.clockOut},${totalHours},${ot1.toFixed(1)},${ot2.toFixed(1)},${Math.round(overtimePay)}\n`;
              fullRecordCsvContent += `${attendance.date},${attendance.clockIn},${attendance.clockOut},${attendance.isHoliday ? "是" : "否"},${totalHours},${ot1.toFixed(1)},${ot2.toFixed(1)},${Math.round(overtimePay)}\n`;
            });
          }

          // 將CSV內容添加到ZIP檔案中
          zip.file(
            `考勤記錄_${record.salaryYear}年${record.salaryMonth}月.csv`,
            attendanceCsvContent,
          );
          zip.file(
            `完整薪資記錄_${record.salaryYear}年${record.salaryMonth}月.csv`,
            fullRecordCsvContent,
          );

          return { success: true, recordId: record.id };
        } catch (err) {
          console.error(`Error creating CSV for record ${record.id}:`, err);
          return { success: false, recordId: record.id, error: err };
        }
      });

      // 等待所有記錄處理完成
      await Promise.all(exportPromises);

      // 生成ZIP檔案
      const zipContent = await zip.generateAsync({ type: "blob" });

      // 創建下載連結
      const zipUrl = URL.createObjectURL(zipContent);
      const downloadLink = document.createElement("a");
      downloadLink.href = zipUrl;
      downloadLink.download = `薪資記錄_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(downloadLink);
      downloadLink.click();

      // 清理
      setTimeout(() => {
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(zipUrl);
      }, 500);

      toast({
        title: "匯出成功",
        description: `已成功匯出 ${selectedRecordIds.length} 筆薪資記錄為ZIP壓縮檔案。`,
      });
    } catch (error) {
      console.error("Error downloading records as ZIP:", error);
      toast({
        title: "匯出失敗",
        description: "無法匯出選定的薪資紀錄，請稍後再試。",
        variant: "destructive",
      });
    } finally {
      setIsExportingZip(false);
    }
  };

  // 未登入時顯示登入提示
  if (!isAdmin) {
    return (
      <div className="page-stack">
        <section className="page-panel-muted">
          <div className="page-header">
            <div className="page-header-copy">
              <h2 className="page-title">歷史薪資紀錄</h2>
            </div>
          </div>
        </section>

        <div className="page-panel mx-auto max-w-2xl text-center">
          <div className="flex justify-center mb-6">
            <div className="bg-primary/10 p-6 rounded-full">
              <Lock className="w-16 h-16 text-primary" />
            </div>
          </div>

          <h3 className="text-2xl font-bold mb-4 text-gray-800">
            需要管理員權限
          </h3>
          <p className="text-gray-600 mb-8 text-lg">
            歷史薪資記錄包含敏感的員工薪資資料，僅限管理員查看。
            <br />
            請先登入管理員帳號以存取此功能。
          </p>

          <Button
            onClick={() => setIsLoginModalOpen(true)}
            size="lg"
            className="w-full bg-primary px-8 py-3 text-lg text-white hover:bg-primary/90 sm:w-auto"
          >
            <Shield className="w-5 h-5 mr-2" />
            管理員登入
          </Button>

          <div className="mt-8 pt-8 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              <Lock className="w-4 h-4 inline mr-1" />
              系統採用 PIN 碼驗證確保資料安全
            </p>
          </div>
        </div>

        {/* Admin Login Dialog */}
        <AdminLoginDialog
          isOpen={isLoginModalOpen}
          onClose={() => setIsLoginModalOpen(false)}
          onSuccess={() => {
            setIsLoginModalOpen(false);
            toast({
              title: "管理員驗證成功",
              description: "您已進入管理員模式，現在可以查看歷史薪資記錄。",
            });
          }}
          title="管理員登入"
          description="請輸入管理員 PIN 碼以查看歷史薪資記錄。"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <section className="page-panel-muted">
        <div className="page-header">
          <div className="page-header-copy">
            <h2 className="page-title">歷史薪資紀錄</h2>
            <p className="page-subtitle">
              目前共有 {filteredRecords.length} 筆符合條件的薪資紀錄。
            </p>
          </div>

          <div className="page-actions">
            <div className="page-badge page-badge-primary">
              <Shield className="h-4 w-4" />
              管理員模式
            </div>
          </div>
        </div>
      </section>

      <section className="page-toolbar">
        {isAdmin && (
          <div className="page-toolbar-group">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsImportModalOpen(true)}
              className="w-full justify-center border-primary/50 text-primary hover:bg-primary/10 sm:w-auto"
            >
              <Upload className="w-4 h-4 mr-1" />
              匯入 CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                toast({
                  title: "資料庫備份",
                  description: "正在執行資料庫備份...",
                });
              }}
              className="w-full justify-center border-primary/50 text-primary hover:bg-primary/10 sm:w-auto"
            >
              <Database className="w-4 h-4 mr-1" />
              資料備份
            </Button>
            {/* 套用統一計算標準按鈕已移除 - 所有計算現在都自動使用標準化方法 */}
            {/* 下載 CSV 按鈕已移除 - 使用批量下載 ZIP 功能代替 */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchDownloadAsZip}
              disabled={isExportingZip || selectedRecordIds.length === 0}
              className="w-full justify-center border-primary/50 text-primary hover:bg-primary/10 sm:w-auto"
            >
              <Archive className="w-4 h-4 mr-1" />
              {isExportingZip ? "處理中..." : "批量下載 ZIP"}
            </Button>
          </div>
        )}

        <div className="w-full lg:max-w-3xl">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(0,0.85fr))]">
            <div className="relative min-w-0 sm:col-span-2 xl:col-span-1">
              <Input
                id="historySearch"
                placeholder="搜尋..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full border-gray-300 px-4 py-2 pr-10 focus:border-primary focus:ring-primary"
              />
              <span className="material-icons absolute right-3 top-2.5 text-gray-400">
                search
              </span>
            </div>

            <Select value={yearFilter} onValueChange={setYearFilter}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="年份" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有年份</SelectItem>
                {availableYears.map((year) => (
                  <SelectItem key={year} value={year.toString()}>
                    {year}年
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="選擇員工" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有員工</SelectItem>
                {!isLoadingEmployees &&
                activeEmployees &&
                activeEmployees.length > 0 ? (
                  activeEmployees.map((employee) => (
                    <SelectItem
                      key={employee.id}
                      value={employee.id.toString()}
                    >
                      {employee.name}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="loading" disabled>
                    載入員工資料中...
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {/* History Records Table */}
      <HistoryTable
        records={paginatedRecords}
        isLoading={isLoading}
        onDownloadPdf={handleDownloadPdf}
        onDeleteRecord={handleDeleteClick}
        onEditRecord={handleEditClick}
        isDeleting={isDeletingRecord}
        isAdmin={isAdmin}
        selectedRecords={selectedRecordIds}
        onSelectRecord={handleSelectRecord}
        onSelectAll={handleSelectAll}
      />

      {/* 選擇的記錄信息 */}
      {selectedRecordIds.length > 0 && (
        <section className="page-panel-muted">
          <div className="page-header">
            <div className="page-header-copy">
              <div className="text-sm text-slate-600">
                已選擇{" "}
                <span className="font-bold text-primary">
                  {selectedRecordIds.length}
                </span>{" "}
                筆記錄
              </div>
            </div>

            <div className="page-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={handleBatchDownloadAsZip}
                disabled={isExportingZip}
                className="w-full justify-center border-primary/50 text-primary hover:bg-primary/10 sm:w-auto"
              >
                <Archive className="w-4 h-4 mr-1" />
                {isExportingZip ? "處理中..." : "下載 ZIP 壓縮檔"}
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Pagination */}
      <section className="page-panel-muted">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-gray-500">
            顯示 {visibleStart} 至 {visibleEnd} 筆，共 {filteredRecords.length}{" "}
            筆紀錄
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className={`rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-50 ${
                effectiveCurrentPage === 1 || !hasFilteredRecords
                  ? "cursor-not-allowed opacity-50"
                  : ""
              }`}
              disabled={effectiveCurrentPage === 1 || !hasFilteredRecords}
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
            >
              <span className="material-icons text-sm">chevron_left</span>
            </button>

            {pageNumbers.map((pageNum) => (
              <button
                key={pageNum}
                className={`min-w-9 rounded-md border border-gray-300 px-3 py-1 ${
                  effectiveCurrentPage === pageNum
                    ? "bg-primary text-white"
                    : "hover:bg-gray-50"
                }`}
                onClick={() => setCurrentPage(pageNum)}
              >
                {pageNum}
              </button>
            ))}

            <button
              className={`rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-50 ${
                effectiveCurrentPage === totalPages || !hasFilteredRecords
                  ? "cursor-not-allowed opacity-50"
                  : ""
              }`}
              disabled={
                effectiveCurrentPage === totalPages || !hasFilteredRecords
              }
              onClick={() =>
                setCurrentPage((prev) => Math.min(prev + 1, totalPages))
              }
            >
              <span className="material-icons text-sm">chevron_right</span>
            </button>
          </div>
        </div>
      </section>

      {/* 已移除查看詳情功能 */}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setRecordToDelete(null);
        }}
        onConfirm={handleConfirmDelete}
        title="刪除薪資紀錄"
        message="您確定要刪除這筆薪資紀錄嗎？此操作無法復原。"
        isProcessing={isDeletingRecord}
      />

      {/* Admin Login Dialog */}
      <AdminLoginDialog
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onSuccess={() => {
          setIsLoginModalOpen(false);
          toast({
            title: "管理員驗證成功",
            description: "您已進入管理員模式，可以執行編輯和刪除操作。",
          });
        }}
        title="需要管理員權限"
        description="編輯或刪除薪資紀錄需要管理員權限。請輸入管理員PIN碼進行驗證。"
      />

      {/* Edit History Record Modal */}
      <EditHistoryRecordModal
        record={recordToEdit}
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setRecordToEdit(null);
        }}
        onSave={handleSaveEditedRecord}
        isSaving={isUpdatingRecord}
      />

      {/* CSV Import Modal */}
      <CsvImportModal
        open={isImportModalOpen}
        onOpenChange={setIsImportModalOpen}
        onImportSuccess={() => {
          refetch();
          toast({
            title: "匯入成功",
            description: "資料已成功匯入，刷新歷史紀錄。",
          });
        }}
      />
    </div>
  );
}
