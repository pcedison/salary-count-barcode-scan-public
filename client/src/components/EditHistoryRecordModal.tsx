import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency } from '@/lib/utils';
import { calculateHistoryRecordTotals } from '@/lib/historyRecordMath';
import { Loader2, Save, XCircle, Plus, Trash2, Calendar, DollarSign, Clock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Allowance {
  name: string;
  amount: number;
  description?: string;
}

interface Deduction {
  name: string;
  amount: number;
}

interface SpecialLeaveInfo {
  usedDays: number;
  usedDates: string[];
  cashDays: number;
  cashAmount: number;
  notes?: string;
}

interface EditHistoryRecordModalProps {
  record: any;
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: number, updatedData: any) => Promise<void>;
  isSaving: boolean;
}

export default function EditHistoryRecordModal({
  record,
  isOpen,
  onClose,
  onSave,
  isSaving
}: EditHistoryRecordModalProps) {
  const [attendanceData, setAttendanceData] = useState<any[]>([]);
  const [allowances, setAllowances] = useState<Allowance[]>([]);
  const [deductions, setDeductions] = useState<Deduction[]>([]);
  const [housingAllowance, setHousingAllowance] = useState<number>(0);
  const [baseSalary, setBaseSalary] = useState<number>(0);
  const [specialLeaveInfo, setSpecialLeaveInfo] = useState<SpecialLeaveInfo | null>(null);

  useEffect(() => {
    if (record && isOpen) {
      setAttendanceData(JSON.parse(JSON.stringify(record.attendanceData || [])));
      setAllowances(JSON.parse(JSON.stringify(record.allowances || [])));
      setDeductions(JSON.parse(JSON.stringify(record.deductions || [])));
      setHousingAllowance(record.housingAllowance || 0);
      setBaseSalary(record.baseSalary || 0);
      setSpecialLeaveInfo(record.specialLeaveInfo || null);
    }
  }, [record, isOpen]);

  const updateAttendanceField = (index: number, field: string, value: any) => {
    const updatedData = [...attendanceData];
    updatedData[index] = { ...updatedData[index], [field]: value };
    setAttendanceData(updatedData);
  };

  const updateAllowance = (index: number, field: keyof Allowance, value: any) => {
    const updated = [...allowances];
    updated[index] = { ...updated[index], [field]: field === 'amount' ? parseFloat(value) || 0 : value };
    setAllowances(updated);
  };

  const addAllowance = () => {
    setAllowances([...allowances, { name: '', amount: 0, description: '' }]);
  };

  const removeAllowance = (index: number) => {
    setAllowances(allowances.filter((_, i) => i !== index));
  };

  const updateDeduction = (index: number, field: keyof Deduction, value: any) => {
    const updated = [...deductions];
    updated[index] = { ...updated[index], [field]: field === 'amount' ? parseFloat(value) || 0 : value };
    setDeductions(updated);
  };

  const addDeduction = () => {
    setDeductions([...deductions, { name: '', amount: 0 }]);
  };

  const removeDeduction = (index: number) => {
    setDeductions(deductions.filter((_, i) => i !== index));
  };

  const calculateTotals = () => {
    return calculateHistoryRecordTotals({
      allowances,
      deductions,
      baseSalary,
      housingAllowance,
      totalOvertimePay: record?.totalOvertimePay || 0,
      totalHolidayPay: record?.totalHolidayPay || 0,
      specialLeaveInfo
    });
  };

  const handleSave = async () => {
    if (!record) return;

    const { totalAllowances, totalDeductions, welfareAllowance, grossSalary, netSalary } = calculateTotals();

    await onSave(record.id, {
      attendanceData,
      allowances,
      deductions,
      housingAllowance,
      baseSalary,
      welfareAllowance,
      totalDeductions,
      grossSalary,
      netSalary,
      specialLeaveInfo
    });
  };

  if (!record) {
    return null;
  }

  const { totalAllowances, totalDeductions, grossSalary, netSalary } = calculateTotals();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-medium text-gray-900">
            編輯 {record.salaryYear}年{record.salaryMonth}月 薪資記錄
          </DialogTitle>
          <DialogDescription className="sr-only">
            編輯歷史薪資記錄的所有欄位
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="attendance" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="attendance" className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              考勤記錄
            </TabsTrigger>
            <TabsTrigger value="allowances" className="flex items-center gap-1">
              <Plus className="w-4 h-4" />
              津貼項目
            </TabsTrigger>
            <TabsTrigger value="deductions" className="flex items-center gap-1">
              <DollarSign className="w-4 h-4" />
              扣款項目
            </TabsTrigger>
            <TabsTrigger value="special" className="flex items-center gap-1">
              <Calendar className="w-4 h-4" />
              特別假
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attendance" className="space-y-4">
            <div className="grid grid-cols-2 gap-4 bg-gray-50 p-3 rounded-md">
              <div>
                <Label className="text-sm text-gray-500">基本薪資</Label>
                <Input
                  type="number"
                  value={baseSalary}
                  onChange={(e) => setBaseSalary(parseFloat(e.target.value) || 0)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-sm text-gray-500">住宿津貼</Label>
                <Input
                  type="number"
                  value={housingAllowance}
                  onChange={(e) => setHousingAllowance(parseFloat(e.target.value) || 0)}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="border rounded-md max-h-[300px] overflow-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">日期</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">上班時間</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">下班時間</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-gray-500">假日類型</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {attendanceData.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
                        沒有考勤記錄
                      </td>
                    </tr>
                  ) : (
                    attendanceData.map((item, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-3 py-2 whitespace-nowrap font-['Roboto_Mono'] text-sm">
                          <DateTimePicker
                            mode="date"
                            value={item.date}
                            onChange={(value) => updateAttendanceField(index, 'date', value)}
                            className="w-full"
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap font-['Roboto_Mono'] text-sm">
                          <DateTimePicker
                            mode="time"
                            value={item.clockIn}
                            onChange={(value) => updateAttendanceField(index, 'clockIn', value)}
                            className="w-full"
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap font-['Roboto_Mono'] text-sm">
                          <DateTimePicker
                            mode="time"
                            value={item.clockOut}
                            onChange={(value) => updateAttendanceField(index, 'clockOut', value)}
                            className="w-full"
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-center">
                          <Select
                            value={item.holidayType || (item.isHoliday ? 'worked' : 'normal')}
                            onValueChange={(value) => {
                              updateAttendanceField(index, 'holidayType', value);
                              updateAttendanceField(index, 'isHoliday', value !== 'normal');
                            }}
                          >
                            <SelectTrigger className="w-[130px]">
                              <SelectValue placeholder="選擇類型" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="normal">一般工作日</SelectItem>
                              <SelectItem value="worked">假日出勤</SelectItem>
                              <SelectItem value="national_holiday">國定假日</SelectItem>
                              <SelectItem value="sick_leave">病假</SelectItem>
                              <SelectItem value="personal_leave">事假</SelectItem>
                              <SelectItem value="typhoon_leave">颱風假</SelectItem>
                              <SelectItem value="special_leave">特別假</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="allowances" className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-medium">津貼項目</h3>
              <Button size="sm" variant="outline" onClick={addAllowance}>
                <Plus className="w-4 h-4 mr-1" />
                新增津貼
              </Button>
            </div>

            <div className="space-y-3">
              {allowances.length === 0 ? (
                <div className="text-center text-gray-500 py-4 border rounded-md">
                  沒有津貼項目，點擊「新增津貼」開始添加
                </div>
              ) : (
                allowances.map((allowance, index) => (
                  <div key={index} className="flex items-center gap-3 p-3 border rounded-md bg-green-50/50">
                    <div className="flex-1">
                      <Label className="text-xs text-gray-500">項目名稱</Label>
                      <Input
                        value={allowance.name}
                        onChange={(e) => updateAllowance(index, 'name', e.target.value)}
                        placeholder="例：住宿福利金"
                        className="mt-1"
                      />
                    </div>
                    <div className="w-32">
                      <Label className="text-xs text-gray-500">金額</Label>
                      <Input
                        type="number"
                        value={allowance.amount}
                        onChange={(e) => updateAllowance(index, 'amount', e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div className="flex-1">
                      <Label className="text-xs text-gray-500">說明</Label>
                      <Input
                        value={allowance.description || ''}
                        onChange={(e) => updateAllowance(index, 'description', e.target.value)}
                        placeholder="選填"
                        className="mt-1"
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-red-500 hover:text-red-700 mt-5"
                      onClick={() => removeAllowance(index)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="bg-green-100 p-3 rounded-md text-right">
              <span className="text-sm text-gray-600">津貼總計：</span>
              <span className="ml-2 font-bold text-green-700">{formatCurrency(totalAllowances)}</span>
            </div>
          </TabsContent>

          <TabsContent value="deductions" className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-medium">扣款項目</h3>
              <Button size="sm" variant="outline" onClick={addDeduction}>
                <Plus className="w-4 h-4 mr-1" />
                新增扣款
              </Button>
            </div>

            <div className="space-y-3">
              {deductions.length === 0 ? (
                <div className="text-center text-gray-500 py-4 border rounded-md">
                  沒有扣款項目，點擊「新增扣款」開始添加
                </div>
              ) : (
                deductions.map((deduction, index) => (
                  <div key={index} className="flex items-center gap-3 p-3 border rounded-md bg-red-50/50">
                    <div className="flex-1">
                      <Label className="text-xs text-gray-500">項目名稱</Label>
                      <Input
                        value={deduction.name}
                        onChange={(e) => updateDeduction(index, 'name', e.target.value)}
                        placeholder="例：勞保費"
                        className="mt-1"
                      />
                    </div>
                    <div className="w-32">
                      <Label className="text-xs text-gray-500">金額</Label>
                      <Input
                        type="number"
                        value={deduction.amount}
                        onChange={(e) => updateDeduction(index, 'amount', e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-red-500 hover:text-red-700 mt-5"
                      onClick={() => removeDeduction(index)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="bg-red-100 p-3 rounded-md text-right">
              <span className="text-sm text-gray-600">扣款總計：</span>
              <span className="ml-2 font-bold text-red-700">-{formatCurrency(totalDeductions)}</span>
            </div>
          </TabsContent>

          <TabsContent value="special" className="space-y-4">
            <div className="bg-blue-50 p-4 rounded-md">
              <h3 className="text-sm font-medium mb-3">特別假使用記錄</h3>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-gray-500">已使用特別假天數</Label>
                  <Input
                    type="number"
                    value={specialLeaveInfo?.usedDays || 0}
                    onChange={(e) => setSpecialLeaveInfo({
                      ...specialLeaveInfo || { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0 },
                      usedDays: parseInt(e.target.value) || 0
                    })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs text-gray-500">折抵日薪天數</Label>
                  <Input
                    type="number"
                    value={specialLeaveInfo?.cashDays || 0}
                    onChange={(e) => {
                      const days = parseInt(e.target.value) || 0;
                      const dailySalary = baseSalary / 30;
                      setSpecialLeaveInfo({
                        ...specialLeaveInfo || { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0 },
                        cashDays: days,
                        cashAmount: Math.round(days * dailySalary)
                      });
                    }}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="mt-3">
                <Label className="text-xs text-gray-500">折抵金額</Label>
                <div className="text-lg font-bold text-blue-700 mt-1">
                  {formatCurrency(specialLeaveInfo?.cashAmount || 0)}
                </div>
              </div>

              <div className="mt-3">
                <Label className="text-xs text-gray-500">備註</Label>
                <Input
                  value={specialLeaveInfo?.notes || ''}
                  onChange={(e) => setSpecialLeaveInfo({
                    ...specialLeaveInfo || { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0 },
                    notes: e.target.value
                  })}
                  placeholder="特別假相關備註"
                  className="mt-1"
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="border-t pt-4 mt-4">
          <div className="grid grid-cols-4 gap-4 text-center mb-4">
            <div className="bg-gray-100 p-2 rounded">
              <div className="text-xs text-gray-500">基本薪資</div>
              <div className="font-medium">{formatCurrency(baseSalary)}</div>
            </div>
            <div className="bg-green-100 p-2 rounded">
              <div className="text-xs text-gray-500">總津貼</div>
              <div className="font-medium text-green-700">+{formatCurrency(totalAllowances + housingAllowance)}</div>
            </div>
            <div className="bg-red-100 p-2 rounded">
              <div className="text-xs text-gray-500">總扣款</div>
              <div className="font-medium text-red-700">-{formatCurrency(totalDeductions)}</div>
            </div>
            <div className="bg-blue-100 p-2 rounded">
              <div className="text-xs text-gray-500">實發金額</div>
              <div className="font-bold text-blue-700">{formatCurrency(netSalary)}</div>
            </div>
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              <XCircle className="w-4 h-4 mr-1" />
              取消
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  儲存中...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-1" />
                  儲存變更
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
