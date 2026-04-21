import { formatCurrency } from '@/lib/utils';
import { Loader2, Edit, Trash2, Printer, Download, User, CalendarDays } from 'lucide-react';
import { useLocation } from 'wouter';
import { Checkbox } from '@/components/ui/checkbox';
import { useEmployees } from '@/hooks/useEmployees';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
    attendanceData?: Array<any>;
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
  onEditRecord?: (record: any) => void;
  isDeleting?: boolean;
  isAdmin?: boolean;
  selectedRecords?: number[];
  onSelectRecord?: (id: number, checked: boolean) => void;
  onSelectAll?: (checked: boolean) => void;
}

type HistoryRecord = HistoryTableProps['records'][number];

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
  const { activeEmployees } = useEmployees();

  const getEmployeesFromAttendanceData = (attendanceData: any[]) => {
    if (!attendanceData || !Array.isArray(attendanceData) || attendanceData.length === 0) {
      return [];
    }

    if (!activeEmployees || activeEmployees.length === 0) {
      return [];
    }

    const employeeIds = Array.from(
      new Set(attendanceData.map((entry) => entry.employeeId).filter((id) => id !== undefined))
    );

    return employeeIds.map((id) => {
      const employee = activeEmployees.find((emp) => emp.id === id);
      return employee ? employee.name : `員工ID: ${id}`;
    });
  };

  const getEmployeeLabel = (record: HistoryRecord) => {
    if ((record as any).employeeName) {
      return (record as any).employeeName as string;
    }

    if (record.attendanceData && record.attendanceData.length > 0) {
      const names = getEmployeesFromAttendanceData(record.attendanceData);
      if (names.length > 0) {
        return names.join(', ');
      }
    }

    return '無員工資料';
  };

  const renderEmployeeDetails = (record: HistoryRecord) => (
    <div>
      {(record as any).employeeName || (record.attendanceData && record.attendanceData.length > 0) ? (
        <div>
          <div className="flex items-center gap-1.5">
            <User className="h-4 w-4 text-primary" />
            <span className="font-medium">{getEmployeeLabel(record)}</span>
          </div>

          {record.specialLeaveInfo && record.specialLeaveInfo.usedDays > 0 && (
            <div className="mt-2 flex items-start gap-1.5">
              <CalendarDays className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
              <div className="flex flex-wrap gap-1">
                {record.specialLeaveInfo.usedDates.map((date, idx) => (
                  <span key={idx} className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-600">
                    {date.slice(5)}
                  </span>
                ))}
                <span className="text-xs text-red-500">特休{record.specialLeaveInfo.usedDays}天</span>
              </div>
            </div>
          )}

          {record.specialLeaveInfo && record.specialLeaveInfo.cashDays > 0 && (
            <div className="mt-2 text-xs text-amber-600">
              折抵{record.specialLeaveInfo.cashDays}天 ({formatCurrency(record.specialLeaveInfo.cashAmount)})
            </div>
          )}
        </div>
      ) : (
        <span className="italic text-gray-400">無考勤資料</span>
      )}
    </div>
  );

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

  const renderMobileActions = (record: HistoryRecord) => (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-center sm:flex-1"
        onClick={() => onDownloadPdf(record)}
      >
        <Download className="h-4 w-4" />
        查看報表
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="w-full justify-center sm:flex-1"
        onClick={() => setLocation(`/print-salary?id=${record.id}`)}
      >
        <Printer className="h-4 w-4" />
        列印薪資單
      </Button>

      {onEditRecord && isAdmin && (
        <Button
          variant="outline"
          size="sm"
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
          size="sm"
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">載入資料中...</span>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="rounded-lg bg-white p-10 text-center text-gray-500 shadow">
        目前沒有歷史薪資紀錄。完成薪資結算後，記錄將會顯示在這裡。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {onSelectRecord && onSelectAll && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm md:hidden">
          <span className="text-sm font-medium text-gray-700">批次選取</span>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <Checkbox
              checked={records.length > 0 && selectedRecords.length === records.length}
              onCheckedChange={(checked) => onSelectAll(checked === true)}
            />
            全選
          </label>
        </div>
      )}

      <div className="space-y-3 md:hidden">
        {records.map((record) => {
          const totalOvertimeHours = (record.totalOT1Hours + record.totalOT2Hours).toFixed(1);
          const isSelected = selectedRecords.includes(record.id);

          return (
            <div key={record.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    {record.salaryYear}年{record.salaryMonth}月
                  </div>
                  <div className="mt-1 text-xs text-gray-500">歷史薪資紀錄</div>
                </div>

                {onSelectRecord && (
                  <label className="flex items-center gap-2 text-xs text-gray-500">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) => onSelectRecord(record.id, checked === true)}
                    />
                    勾選
                  </label>
                )}
              </div>

              <div className="mt-4 rounded-xl bg-gray-50 p-3">
                {renderEmployeeDetails(record)}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">基本薪資</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm">{formatCurrency(record.baseSalary)}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">加班時數</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm">{totalOvertimeHours}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">加班費</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm">{formatCurrency(record.totalOvertimePay)}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">假日加班</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm">{formatCurrency(record.totalHolidayPay)}</div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-500">實發金額</div>
                <div className="mt-1 font-['Roboto_Mono'] text-lg font-semibold text-slate-900">
                  {formatCurrency(record.netSalary)}
                </div>
              </div>

              <div className={cn("mt-4", isSelected && "rounded-xl border border-blue-100 bg-blue-50 p-3")}>
                {renderMobileActions(record)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-lg bg-white shadow md:block">
        <table className="min-w-full divide-y divide-gray-200">
          <thead>
            <tr className="bg-gray-50">
              {onSelectRecord && (
                <th className="w-10 py-3 pl-6 pr-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                  {onSelectAll && (
                    <Checkbox
                      checked={records.length > 0 && selectedRecords.length === records.length}
                      onCheckedChange={(checked) => onSelectAll(checked === true)}
                    />
                  )}
                </th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">年月</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">員工</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">基本薪資</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">加班時數</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">加班費</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">假日加班</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">實發金額</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {records.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50">
                {onSelectRecord && (
                  <td className="w-10 py-4 pl-6 pr-3 whitespace-nowrap">
                    <Checkbox
                      checked={selectedRecords.includes(record.id)}
                      onCheckedChange={(checked) => onSelectRecord(record.id, checked === true)}
                    />
                  </td>
                )}
                <td className="px-4 py-4 whitespace-nowrap font-medium lg:px-6">
                  {record.salaryYear}年{record.salaryMonth}月
                </td>
                <td className="px-4 py-4 lg:px-6">
                  {renderEmployeeDetails(record)}
                </td>
                <td className="px-4 py-4 font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {formatCurrency(record.baseSalary)}
                </td>
                <td className="px-4 py-4 text-center font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {(record.totalOT1Hours + record.totalOT2Hours).toFixed(1)}
                </td>
                <td className="px-4 py-4 text-center font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {formatCurrency(record.totalOvertimePay)}
                </td>
                <td className="px-4 py-4 text-center font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {formatCurrency(record.totalHolidayPay)}
                </td>
                <td className="px-4 py-4 text-right font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {formatCurrency(record.netSalary)}
                </td>
                <td className="px-4 py-4 text-center whitespace-nowrap lg:px-6">
                  {renderDesktopActions(record)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
