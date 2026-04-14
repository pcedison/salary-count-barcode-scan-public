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
import { calculateOvertime } from '@/lib/utils';
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
    _employeeName?: string; // 臨時存儲員工名稱
    _employeeDepartment?: string; // 臨時存儲員工部門
    _isLeaveRecord?: boolean; // 是否為假日記錄（來自 holidays 資料表）
    _isNoClockType?: boolean; // 是否為無打卡類型（國定假日、病假、事假、颱風假）
    _holidayType?: string; // 假日類型
    _holidayName?: string; // 假日名稱標籤
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

export default function AttendanceTable({
  data,
  isLoading,
  canEdit = true,
  onUpdateAttendance,
  onDeleteAttendance,
}: AttendanceTableProps) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [editDate, setEditDate] = useState<string>('');
  const [editClockIn, setEditClockIn] = useState<string>('');
  const [editClockOut, setEditClockOut] = useState<string>('');
  const [updatingHolidayType, setUpdatingHolidayType] = useState<number | null>(null);

  const holidayTypeOptions = [
    { value: 'none', label: '正常出勤', color: 'bg-gray-100 text-gray-800' },
    { value: 'special_leave', label: '特別休假', color: 'bg-teal-100 text-teal-800' },
    { value: 'sick_leave', label: '病假', color: 'bg-yellow-100 text-yellow-800' },
    { value: 'personal_leave', label: '事假', color: 'bg-orange-100 text-orange-800' },
    { value: 'worked', label: '假日出勤', color: 'bg-blue-100 text-blue-800' },
  ];

  // Start editing an attendance record
  const handleEdit = (record: any) => {
    setEditingId(record.id);
    setEditingRecord(record);
    setEditDate(record.date);
    // 初始化編輯欄位，處理 --:-- 特殊值
    setEditClockIn(record.clockIn === '--:--' ? '' : record.clockIn);
    setEditClockOut(record.clockOut === '--:--' ? '' : record.clockOut);
  };

  // Save edited record
  const handleSaveEdit = async () => {
    if (!editingId || !editingRecord) return;

    try {
      // 所有記錄都是真實記錄，使用更新
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

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingId(null);
  };

  // Handle holiday type change
  const handleHolidayTypeChange = async (recordId: number, newType: string) => {
    setUpdatingHolidayType(recordId);
    try {
      const updateData: any = {
        holidayType: newType === 'none' ? null : newType,
        isHoliday: newType !== 'none'
      };
      await onUpdateAttendance(recordId, updateData);
      const typeLabel = holidayTypeOptions.find(opt => opt.value === newType)?.label || '正常出勤';
      toast({
        title: "已更新",
        description: `考勤記錄已標記為「${typeLabel}」`,
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

  // Delete record
  const handleDelete = async (id: number) => {
    if (confirm('確定要刪除此考勤記錄嗎？')) {
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
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">載入資料中...</span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto bg-white rounded-lg shadow">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">員工</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">部門</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">日期</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">上班時間</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">下班時間</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">工作小時</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">加班時數</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">假日類型</th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              {canEdit ? '操作' : '狀態'}
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {data.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-6 py-10 text-center text-gray-500">
                尚無考勤記錄。請使用上方表單新增或使用條碼掃描功能。
              </td>
            </tr>
          ) : (
            data.map((record, index) => {
              const isHolidayRecord = record._isLeaveRecord === true;
              const isNoClockType = record._isNoClockType === true;
              const holidayType = record._holidayType;

              // 需要單獨計算工作小時的假日類型：病假、事假、假日出勤
              const isFlexibleHolidayType = ['sick_leave', 'personal_leave', 'worked'].includes(holidayType || '');

              const { ot1, ot2, total } = isNoClockType ? { ot1: 0, ot2: 0, total: 0 } : calculateOvertime(record.clockIn, record.clockOut);
              const isEditing = editingId === record.id;

              // 計算實際工作小時（用於病假、事假、假日出勤）
              // 使用與一般上班日相同的邏輯：早於 8:00 上班從 8:00 開始計算
              const calculateActualWorkHours = (clockIn: string, clockOut: string): number => {
                if (!clockIn || !clockOut || clockIn === '待補' || clockOut === '待補') return 0;
                const [inH, inM] = clockIn.split(':').map(Number);
                const [outH, outM] = clockOut.split(':').map(Number);

                // 計算上班時間（分鐘）
                let inMinutes = inH * 60 + inM;
                const WORK_START = 8 * 60; // 8:00 = 480 分鐘

                // 早到處理：如果早於 8:00 上班，從 8:00 開始計算
                if (inMinutes < WORK_START) {
                  inMinutes = WORK_START;
                }

                const outMinutes = outH * 60 + outM;
                const totalMinutes = outMinutes - inMinutes;

                // 四捨五入到整數位
                return Math.round(totalMinutes / 60);
              };

              const actualWorkHours = isFlexibleHolidayType ? calculateActualWorkHours(record.clockIn, record.clockOut) : 0;

              // 假日類型的樣式
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

              // 假日記錄使用特殊的背景色
              const rowClassName = isHolidayRecord
                ? 'bg-gray-100 opacity-90'
                : (index % 2 === 1 ? 'bg-gray-50' : '');

              return (
                <tr key={record.id} className={rowClassName}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {record._employeeName
                      ? <span className="font-medium">{record._employeeName}</span>
                      : (record.employeeId
                          ? <span className="text-orange-600">員工 ID: {record.employeeId}</span>
                          : <span className="text-gray-500">手動輸入</span>)
                    }
                    {record.isBarcodeScanned && <span className="ml-1 px-1 py-0.5 bg-blue-100 text-blue-800 text-xs rounded">條碼</span>}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {record._employeeDepartment
                      ? <span className="text-gray-700">{record._employeeDepartment}</span>
                      : <span className="text-gray-400">-</span>
                    }
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-['Roboto_Mono']">
                    {isEditing ? (
                      <DateTimePicker
                        mode="date"
                        value={editDate}
                        onChange={setEditDate}
                        className="w-full"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        {record.date}
                        {isHolidayRecord && record._holidayName && (
                          <span className={`px-2 py-1 text-xs rounded-full font-medium ${getHolidayTypeStyle(record._holidayType)}`}>
                            {record._holidayName}
                          </span>
                        )}
                        {!isHolidayRecord && record.isHoliday && (
                          <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded-full">
                            假日
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-['Roboto_Mono']">
                    {isNoClockType ? (
                      <span className="text-gray-400">--:--</span>
                    ) : isEditing ? (
                      <DateTimePicker
                        mode="time"
                        value={editClockIn}
                        onChange={setEditClockIn}
                        className="w-full"
                      />
                    ) : (
                      record.clockIn
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-['Roboto_Mono']">
                    {isNoClockType ? (
                      <span className="text-gray-400">--:--</span>
                    ) : isEditing ? (
                      <DateTimePicker
                        mode="time"
                        value={editClockOut}
                        onChange={setEditClockOut}
                        className="w-full"
                      />
                    ) : (
                      record.clockOut ? record.clockOut : <span className="text-amber-500 font-medium">尚未下班</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">
                    {isNoClockType ? (
                      <span className="text-gray-400">0</span>
                    ) : isFlexibleHolidayType ? (
                      actualWorkHours
                    ) : (
                      8
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">
                    {isNoClockType ? <span className="text-gray-400">0.0</span> : (ot1 + ot2).toFixed(1)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    {isNoClockType ? (
                      <span className={`px-2 py-1 text-xs rounded-full font-medium ${getHolidayTypeStyle(holidayType)}`}>
                        {record._holidayName || '假日'}
                      </span>
                    ) : !canEdit ? (
                      holidayType ? (
                        <span className={`px-2 py-1 text-xs rounded-full font-medium ${getHolidayTypeStyle(holidayType)}`}>
                          {record._holidayName || holidayType}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )
                    ) : (
                      <Select
                        value={holidayType || 'none'}
                        onValueChange={(value) => handleHolidayTypeChange(record.id, value)}
                        disabled={updatingHolidayType === record.id}
                      >
                        <SelectTrigger
                          className="h-8 w-28 text-xs"
                          data-testid={`select-holiday-type-${record.id}`}
                        >
                          {updatingHolidayType === record.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <SelectValue placeholder="選擇類型" />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {holidayTypeOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className={`px-1.5 py-0.5 rounded text-xs ${option.color}`}>
                                {option.label}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    {isNoClockType ? (
                      <span className="text-gray-400 text-xs">假日記錄</span>
                    ) : !canEdit ? (
                      <span className="text-gray-400 text-xs">唯讀</span>
                    ) : isEditing ? (
                      <>
                        <Button
                          onClick={handleSaveEdit}
                          className="mr-2 bg-blue-600 hover:bg-blue-700 text-white"
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
                      </>
                    ) : (
                      <>
                        <button
                          className="text-primary hover:text-blue-700"
                          onClick={() => handleEdit(record)}
                          data-testid={`button-edit-${record.id}`}
                        >
                          <span className="material-icons text-sm">edit</span>
                        </button>
                        <button
                          className="text-error hover:text-red-700 ml-3"
                          onClick={() => handleDelete(record.id)}
                          data-testid={`button-delete-${record.id}`}
                        >
                          <span className="material-icons text-sm">delete</span>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
