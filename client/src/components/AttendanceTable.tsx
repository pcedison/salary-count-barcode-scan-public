import { useState } from 'react';
import { useToast } from "@/hooks/use-toast";
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { calculateOvertime, cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface AttendanceTableProps {
  data: Array<{
    id: number;
    employeeId?: number | null;
    date: string;
    clockIn: string;
    clockOut: string;
    isHoliday: boolean;
    isBarcodeScanned?: boolean;
    _employeeName?: string;
    _employeeDepartment?: string;
    _isLeaveRecord?: boolean;
    _isNoClockType?: boolean;
    _holidayType?: string;
    _holidayName?: string;
  }>;
  isLoading: boolean;
  canEdit?: boolean;
  onUpdateAttendance: (id: number, data: {
    date?: string;
    clockIn?: string;
    clockOut?: string;
    isHoliday?: boolean;
    holidayType?: string | null;
  }) => Promise<boolean>;
  onDeleteAttendance: (id: number) => Promise<boolean>;
}

type AttendanceRecord = AttendanceTableProps['data'][number];

const holidayTypeOptions = [
  { value: 'none', label: '正常出勤', color: 'bg-gray-100 text-gray-800' },
  { value: 'special_leave', label: '特別休假', color: 'bg-teal-100 text-teal-800' },
  { value: 'sick_leave', label: '病假', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'personal_leave', label: '事假', color: 'bg-orange-100 text-orange-800' },
  { value: 'worked', label: '假日出勤', color: 'bg-blue-100 text-blue-800' },
];

const calculateActualWorkHours = (clockIn: string, clockOut: string): number => {
  if (!clockIn || !clockOut || clockIn === '待補' || clockOut === '待補') return 0;

  const [inH, inM] = clockIn.split(':').map(Number);
  const [outH, outM] = clockOut.split(':').map(Number);

  let inMinutes = inH * 60 + inM;
  const workStart = 8 * 60;

  if (inMinutes < workStart) {
    inMinutes = workStart;
  }

  const outMinutes = outH * 60 + outM;
  const totalMinutes = outMinutes - inMinutes;

  return Math.round(totalMinutes / 60);
};

const getHolidayTypeStyle = (holidayType?: string) => {
  switch (holidayType) {
    case 'national_holiday':
      return 'bg-green-100 text-green-800';
    case 'sick_leave':
      return 'bg-yellow-100 text-yellow-800';
    case 'personal_leave':
      return 'bg-orange-100 text-orange-800';
    case 'special_leave':
      return 'bg-teal-100 text-teal-800';
    case 'typhoon_leave':
      return 'bg-purple-100 text-purple-800';
    case 'worked':
      return 'bg-blue-100 text-blue-800';
    default:
      return 'bg-red-100 text-red-800';
  }
};

const getHolidayTypeLabel = (holidayType?: string) => {
  if (!holidayType) return '正常出勤';
  return holidayTypeOptions.find((option) => option.value === holidayType)?.label || holidayType;
};

export default function AttendanceTable({
  data,
  isLoading,
  canEdit = true,
  onUpdateAttendance,
  onDeleteAttendance,
}: AttendanceTableProps) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingRecord, setEditingRecord] = useState<AttendanceRecord | null>(null);
  const [editDate, setEditDate] = useState<string>('');
  const [editClockIn, setEditClockIn] = useState<string>('');
  const [editClockOut, setEditClockOut] = useState<string>('');
  const [updatingHolidayType, setUpdatingHolidayType] = useState<number | null>(null);

  const handleEdit = (record: AttendanceRecord) => {
    setEditingId(record.id);
    setEditingRecord(record);
    setEditDate(record.date);
    setEditClockIn(record.clockIn === '--:--' ? '' : record.clockIn);
    setEditClockOut(record.clockOut === '--:--' ? '' : record.clockOut);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editingRecord) return;

    try {
      await onUpdateAttendance(editingId, {
        date: editDate,
        clockIn: editClockIn || '08:00',
        clockOut: editClockOut || '17:00'
      });

      toast({
        title: "已更新",
        description: "考勤記錄已成功更新。",
      });

      setEditingId(null);
      setEditingRecord(null);
    } catch (error) {
      console.error('Failed to save record:', error);
      toast({
        title: "儲存失敗",
        description: "無法儲存考勤記錄，請稍後再試。",
        variant: "destructive"
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingRecord(null);
  };

  const handleHolidayTypeChange = async (recordId: number, newType: string) => {
    setUpdatingHolidayType(recordId);

    try {
      await onUpdateAttendance(recordId, {
        holidayType: newType === 'none' ? null : newType,
        isHoliday: newType !== 'none'
      });

      toast({
        title: "已更新",
        description: `考勤記錄已標記為「${getHolidayTypeLabel(newType)}」`,
      });
    } catch (error) {
      console.error('Failed to update holiday type:', error);
      toast({
        title: "更新失敗",
        description: "無法更新假日類型，請稍後再試。",
        variant: "destructive"
      });
    } finally {
      setUpdatingHolidayType(null);
    }
  };

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

  const rows = data.map((record, index) => {
    const isHolidayRecord = record._isLeaveRecord === true;
    const isNoClockType = record._isNoClockType === true;
    const holidayType = record._holidayType;
    const isFlexibleHolidayType = ['sick_leave', 'personal_leave', 'worked'].includes(holidayType || '');
    const { ot1, ot2 } = isNoClockType ? { ot1: 0, ot2: 0 } : calculateOvertime(record.clockIn, record.clockOut);
    const isEditing = editingId === record.id;

    const actualWorkHours = isFlexibleHolidayType
      ? calculateActualWorkHours(record.clockIn, record.clockOut)
      : 0;

    return {
      record,
      isHolidayRecord,
      isNoClockType,
      holidayType,
      isEditing,
      rowClassName: isHolidayRecord ? 'bg-gray-100 opacity-90' : (index % 2 === 1 ? 'bg-gray-50' : ''),
      employeeName: record._employeeName || (record.employeeId ? `員工 ID: ${record.employeeId}` : '手動輸入'),
      departmentName: record._employeeDepartment || '未指定部門',
      workHours: isNoClockType ? '0' : isFlexibleHolidayType ? `${actualWorkHours}` : '8',
      overtimeHours: isNoClockType ? '0.0' : (ot1 + ot2).toFixed(1),
      clockOutDisplay: record.clockOut ? record.clockOut : '尚未下班',
    };
  });

  const renderRecordBadge = (row: typeof rows[number]) => {
    if (row.isHolidayRecord && row.record._holidayName) {
      return (
        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${getHolidayTypeStyle(row.record._holidayType)}`}>
          {row.record._holidayName}
        </span>
      );
    }

    if (!row.isHolidayRecord && row.record.isHoliday) {
      return (
        <span className="inline-flex rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-800">
          假日
        </span>
      );
    }

    return null;
  };

  const renderHolidayTypeControl = (row: typeof rows[number], fullWidth = false) => {
    if (row.isNoClockType) {
      return (
        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${getHolidayTypeStyle(row.holidayType)}`}>
          {row.record._holidayName || '假日'}
        </span>
      );
    }

    if (!canEdit) {
      return row.holidayType ? (
        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${getHolidayTypeStyle(row.holidayType)}`}>
          {row.record._holidayName || getHolidayTypeLabel(row.holidayType)}
        </span>
      ) : (
        <span className="text-sm text-gray-400">-</span>
      );
    }

    return (
      <Select
        value={row.holidayType || 'none'}
        onValueChange={(value) => handleHolidayTypeChange(row.record.id, value)}
        disabled={updatingHolidayType === row.record.id}
      >
        <SelectTrigger
          className={cn("h-9 text-xs", fullWidth ? "w-full" : "w-28")}
          data-testid={`select-holiday-type-${row.record.id}`}
        >
          {updatingHolidayType === row.record.id ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <SelectValue placeholder="選擇類型" />
          )}
        </SelectTrigger>
        <SelectContent>
          {holidayTypeOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className={`rounded px-1.5 py-0.5 text-xs ${option.color}`}>
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  const renderDesktopActions = (row: typeof rows[number]) => {
    if (row.isNoClockType) {
      return <span className="text-xs text-gray-400">假日記錄</span>;
    }

    if (!canEdit) {
      return <span className="text-xs text-gray-400">唯讀</span>;
    }

    if (row.isEditing) {
      return (
        <div className="flex items-center justify-center gap-2">
          <Button
            onClick={handleSaveEdit}
            className="bg-blue-600 text-white hover:bg-blue-700"
            size="sm"
          >
            <span className="material-icons text-sm">check</span>
          </Button>
          <Button
            onClick={handleCancelEdit}
            variant="secondary"
            size="sm"
          >
            <span className="material-icons text-sm">close</span>
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-primary hover:text-blue-700"
          onClick={() => handleEdit(row.record)}
          data-testid={`button-edit-${row.record.id}`}
          aria-label="編輯考勤記錄"
        >
          <span className="material-icons text-sm">edit</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-error hover:text-red-700"
          onClick={() => handleDelete(row.record.id)}
          data-testid={`button-delete-${row.record.id}`}
          aria-label="刪除考勤記錄"
        >
          <span className="material-icons text-sm">delete</span>
        </Button>
      </div>
    );
  };

  const renderMobileActions = (row: typeof rows[number]) => {
    if (row.isNoClockType) {
      return <div className="text-sm text-gray-400">此筆為假日記錄，無需編輯打卡時間。</div>;
    }

    if (!canEdit) {
      return <div className="text-sm text-gray-400">目前為唯讀模式。</div>;
    }

    if (row.isEditing) {
      return (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSaveEdit}
            className="w-full bg-blue-600 text-white hover:bg-blue-700 sm:flex-1"
            size="sm"
          >
            儲存變更
          </Button>
          <Button
            onClick={handleCancelEdit}
            variant="outline"
            className="w-full sm:flex-1"
            size="sm"
          >
            取消
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          className="w-full sm:flex-1"
          size="sm"
          onClick={() => handleEdit(row.record)}
          data-testid={`button-edit-mobile-${row.record.id}`}
        >
          編輯
        </Button>
        <Button
          variant="destructive"
          className="w-full sm:flex-1"
          size="sm"
          onClick={() => handleDelete(row.record.id)}
          data-testid={`button-delete-mobile-${row.record.id}`}
        >
          刪除
        </Button>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">載入資料中...</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
        尚無考勤記錄。請使用上方表單新增或使用條碼掃描功能。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <div
            key={row.record.id}
            className={cn(
              "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm",
              row.isHolidayRecord && "border-gray-300 bg-gray-50"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(
                    "text-sm font-semibold",
                    row.record._employeeName ? "text-gray-900" : row.record.employeeId ? "text-orange-600" : "text-gray-500"
                  )}>
                    {row.employeeName}
                  </span>
                  {row.record.isBarcodeScanned && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                      條碼
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">{row.departmentName}</p>
              </div>

              <div className="text-right">
                <div className="font-['Roboto_Mono'] text-sm font-medium text-gray-900">
                  {row.record.date}
                </div>
                <div className="mt-1">{renderRecordBadge(row)}</div>
              </div>
            </div>

            {row.isEditing ? (
              <div className="mt-4 grid gap-3">
                <div>
                  <div className="mb-1 text-xs font-medium text-gray-500">日期</div>
                  <DateTimePicker
                    mode="date"
                    value={editDate}
                    onChange={setEditDate}
                    className="w-full"
                  />
                </div>
                {!row.isNoClockType && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs font-medium text-gray-500">上班時間</div>
                      <DateTimePicker
                        mode="time"
                        value={editClockIn}
                        onChange={setEditClockIn}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-medium text-gray-500">下班時間</div>
                      <DateTimePicker
                        mode="time"
                        value={editClockOut}
                        onChange={setEditClockOut}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">上班時間</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm text-gray-900">
                    {row.isNoClockType ? '--:--' : row.record.clockIn}
                  </div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">下班時間</div>
                  <div className={cn(
                    "mt-1 font-['Roboto_Mono'] text-sm",
                    row.record.clockOut ? "text-gray-900" : "font-medium text-amber-500"
                  )}>
                    {row.isNoClockType ? '--:--' : row.clockOutDisplay}
                  </div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">工作小時</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm text-gray-900">{row.workHours}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">加班時數</div>
                  <div className="mt-1 font-['Roboto_Mono'] text-sm text-gray-900">{row.overtimeHours}</div>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-xl bg-gray-50 p-3">
              <div className="text-xs font-medium text-gray-500">假日類型</div>
              <div className="mt-2">{renderHolidayTypeControl(row, true)}</div>
            </div>

            <div className="mt-4">{renderMobileActions(row)}</div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-lg bg-white shadow md:block">
        <table className="min-w-full divide-y divide-gray-200">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">員工</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">部門</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">日期</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">上班時間</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">下班時間</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">工作小時</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">加班時數</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">假日類型</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">
                {canEdit ? '操作' : '狀態'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {rows.map((row) => (
              <tr key={row.record.id} className={row.rowClassName}>
                <td className="px-4 py-4 whitespace-nowrap lg:px-6">
                  {row.record._employeeName ? (
                    <span className="font-medium">{row.record._employeeName}</span>
                  ) : row.record.employeeId ? (
                    <span className="text-orange-600">員工 ID: {row.record.employeeId}</span>
                  ) : (
                    <span className="text-gray-500">手動輸入</span>
                  )}
                  {row.record.isBarcodeScanned && (
                    <span className="ml-2 rounded bg-blue-100 px-1 py-0.5 text-xs text-blue-800">條碼</span>
                  )}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-gray-700 lg:px-6">
                  {row.record._employeeDepartment || <span className="text-gray-400">-</span>}
                </td>
                <td className="px-4 py-4 font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {row.isEditing ? (
                    <DateTimePicker
                      mode="date"
                      value={editDate}
                      onChange={setEditDate}
                      className="w-full"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      {row.record.date}
                      {renderRecordBadge(row)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-4 font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {row.isNoClockType ? (
                    <span className="text-gray-400">--:--</span>
                  ) : row.isEditing ? (
                    <DateTimePicker
                      mode="time"
                      value={editClockIn}
                      onChange={setEditClockIn}
                      className="w-full"
                    />
                  ) : (
                    row.record.clockIn
                  )}
                </td>
                <td className="px-4 py-4 font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {row.isNoClockType ? (
                    <span className="text-gray-400">--:--</span>
                  ) : row.isEditing ? (
                    <DateTimePicker
                      mode="time"
                      value={editClockOut}
                      onChange={setEditClockOut}
                      className="w-full"
                    />
                  ) : row.record.clockOut ? (
                    row.record.clockOut
                  ) : (
                    <span className="font-medium text-amber-500">尚未下班</span>
                  )}
                </td>
                <td className="px-4 py-4 text-center font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {row.workHours}
                </td>
                <td className="px-4 py-4 text-center font-['Roboto_Mono'] whitespace-nowrap lg:px-6">
                  {row.overtimeHours}
                </td>
                <td className="px-4 py-4 text-center whitespace-nowrap lg:px-6">
                  {renderHolidayTypeControl(row)}
                </td>
                <td className="px-4 py-4 text-center whitespace-nowrap lg:px-6">
                  {renderDesktopActions(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
