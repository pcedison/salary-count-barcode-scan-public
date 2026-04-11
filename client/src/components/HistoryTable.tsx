import { formatCurrency } from '@/lib/utils';
import { Loader2, Edit, Trash2, Printer, Download, User, CalendarDays } from 'lucide-react';
import { useLocation } from 'wouter';
import { Checkbox } from '@/components/ui/checkbox';
import { useEmployees } from '@/hooks/useEmployees';

interface HistoryTableProps {
  records: Array<{
    id: number;
    salaryYear: number;
    salaryMonth: number;
    baseSalary: number;
    totalOT1Hours: number;
    totalOT2Hours: number;
    totalOvertimePay: number;
    holidayDays: number;
    totalHolidayPay: number;
    netSalary: number;
    attendanceData?: Array<any>; // 考勤記錄數據
    specialLeaveInfo?: {
      usedDays: number;
      usedDates: string[];
      cashDays: number;
      cashAmount: number;
      notes?: string;
    };
  }>;
  isLoading: boolean;
  onDownloadPdf: (record: any) => void;
  onDeleteRecord?: (id: number) => void;
  onEditRecord?: (record: any) => void; // 直接編輯歷史考勤記錄功能
  isDeleting?: boolean;
  isAdmin?: boolean; // 添加是否為管理員的標記
  selectedRecords?: number[]; // 選中的紀錄ID列表
  onSelectRecord?: (id: number, checked: boolean) => void; // 選擇/取消選擇記錄的回調
  onSelectAll?: (checked: boolean) => void; // 全選/取消全選的回調
}

export default function HistoryTable({
  records,
  isLoading,
  onDownloadPdf,
  onDeleteRecord,
  onEditRecord,
  isDeleting = false,
  isAdmin = false,
  selectedRecords = [],
  onSelectRecord,
  onSelectAll
}: HistoryTableProps) {
  const [, setLocation] = useLocation();
  const { activeEmployees, isLoading: isLoadingEmployees } = useEmployees();

  // 函數來獲取員工相關的考勤數據
  const getEmployeesFromAttendanceData = (attendanceData: any[]) => {
    if (!attendanceData || !Array.isArray(attendanceData) || attendanceData.length === 0) {
      return [];
    }

    // 如果員工數據還在加載中，返回空數組
    if (!activeEmployees || activeEmployees.length === 0) {
      return [];
    }

    // 從考勤數據中提取所有員工ID
    const employeeIds = Array.from(new Set(
      attendanceData.map(entry => entry.employeeId).filter(id => id !== undefined)
    ));

    // 獲取員工名字
    return employeeIds.map(id => {
      const employee = activeEmployees.find(emp => emp.id === id);
      return employee ? employee.name : `員工ID: ${id}`;
    });
  };
  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">載入資料中...</span>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-10 text-center text-gray-500">
        目前沒有歷史薪資紀錄。完成薪資結算後，記錄將會顯示在這裡。
      </div>
    );
  }

  return (
    <div className="overflow-x-auto bg-white rounded-lg shadow">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr className="bg-gray-50">
            {onSelectRecord && (
              <th className="pl-6 pr-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                {onSelectAll && (
                  <Checkbox
                    checked={records.length > 0 && selectedRecords.length === records.length}
                    onCheckedChange={(checked) => onSelectAll(checked === true)}
                  />
                )}
              </th>
            )}
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">年月</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">員工</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">基本薪資</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">加班時數</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">加班費</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">假日加班</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">實發金額</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {records.map((record) => (
            <tr key={record.id} className="hover:bg-gray-50">
              {onSelectRecord && (
                <td className="pl-6 pr-3 py-4 whitespace-nowrap w-10">
                  <Checkbox
                    checked={selectedRecords.includes(record.id)}
                    onCheckedChange={(checked) => onSelectRecord(record.id, checked === true)}
                  />
                </td>
              )}
              <td className="px-6 py-4 whitespace-nowrap font-medium">{record.salaryYear}年{record.salaryMonth}月</td>
              <td className="px-6 py-4">
                {/* 統一顯示樣式，無論來源如何，確保一致性 */}
                {(record as any).employeeName || (record.attendanceData && record.attendanceData.length > 0) ? (
                  <div>
                    <div className="flex items-center">
                      <User className="mr-1 h-4 w-4 text-primary" />
                      <span className="font-medium">
                        {(record as any).employeeName ||
                        (record.attendanceData && record.attendanceData.length > 0 ?
                          getEmployeesFromAttendanceData(record.attendanceData).join(', ') : '無員工資料')}
                      </span>
                    </div>
                    {/* 特別假資訊 - 紅色顯示 */}
                    {record.specialLeaveInfo && record.specialLeaveInfo.usedDays > 0 && (
                      <div className="mt-1 flex items-start gap-1">
                        <CalendarDays className="h-3 w-3 text-red-500 mt-0.5 flex-shrink-0" />
                        <div className="flex flex-wrap gap-1">
                          {record.specialLeaveInfo.usedDates.map((date, idx) => (
                            <span key={idx} className="text-xs text-red-600 font-medium bg-red-50 px-1 rounded">
                              {date.slice(5)}
                            </span>
                          ))}
                          <span className="text-xs text-red-500">特休{record.specialLeaveInfo.usedDays}天</span>
                        </div>
                      </div>
                    )}
                    {/* 特別假折抵資訊 */}
                    {record.specialLeaveInfo && record.specialLeaveInfo.cashDays > 0 && (
                      <div className="mt-1 text-xs text-amber-600">
                        💰 折抵{record.specialLeaveInfo.cashDays}天 ({formatCurrency(record.specialLeaveInfo.cashAmount)})
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-gray-400 italic">無考勤資料</span>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap font-['Roboto_Mono']">{formatCurrency(record.baseSalary)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">
                {(record.totalOT1Hours + record.totalOT2Hours).toFixed(1)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">{formatCurrency(record.totalOvertimePay)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">{formatCurrency(record.totalHolidayPay)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-right font-medium font-['Roboto_Mono']">{formatCurrency(record.netSalary)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                <div className="flex items-center justify-center space-x-2">
                  <button
                    className="text-gray-500 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100"
                    onClick={() => onDownloadPdf(record)}
                    title="查看報表"
                  >
                    <Download size={16} />
                  </button>

                  <button
                    className="text-blue-500 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50"
                    onClick={() => setLocation(`/print-salary?id=${record.id}`)}
                    title="列印薪資單"
                  >
                    <Printer size={16} />
                  </button>

                  {onEditRecord && isAdmin && (
                    <button
                      className="text-indigo-500 hover:text-indigo-600 p-1 rounded-full hover:bg-indigo-50"
                      onClick={() => onEditRecord(record)}
                      title="編輯薪資記錄"
                    >
                      <Edit size={16} />
                    </button>
                  )}

                  {onDeleteRecord && isAdmin && (
                    <button
                      className="text-slate-600 hover:text-slate-800 p-1 rounded-full hover:bg-slate-100"
                      onClick={() => onDeleteRecord(record.id)}
                      disabled={isDeleting}
                      title="刪除記錄"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
