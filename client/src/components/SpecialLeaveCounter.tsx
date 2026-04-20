import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Calendar, ExternalLink, Info, DollarSign, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { useQueryClient, useQuery } from '@tanstack/react-query';

interface Employee {
  id: number;
  name: string;
  position?: string;
  department?: string;
  specialLeaveDays?: number;
  specialLeaveWorkDateRange?: string;
  specialLeaveUsedDates?: string[];
  specialLeaveCashDays?: number;
  specialLeaveCashMonth?: string;
  specialLeaveNotes?: string;
}

interface SpecialLeaveCounterProps {
  employees: Employee[];
  isAdmin: boolean;
  baseSalary?: number;
}

export default function SpecialLeaveCounter({ employees: employeesProp, isAdmin, baseSalary = 29500 }: SpecialLeaveCounterProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: employeesFromQuery } = useQuery<Employee[]>({
    queryKey: ['/api/employees/admin'],
    staleTime: 0,
    enabled: isAdmin
  });

  const employees = employeesFromQuery || employeesProp;
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [specialLeaveDays, setSpecialLeaveDays] = useState<number>(0);
  const [workDateRange, setWorkDateRange] = useState<string>('');
  const [usedDates, setUsedDates] = useState<string[]>([]);
  const [newLeaveDate, setNewLeaveDate] = useState<string>('');
  const [cashDays, setCashDays] = useState<number>(0);
  const [cashMonth, setCashMonth] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);

  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId);

  useEffect(() => {
    if (employees.length > 0 && selectedEmployeeId === null) {
      const managerKeywords = ['主管', '經理', '老闆', '負責人', '總監', '董事', '執行長', 'manager', 'director', 'boss', 'owner'];
      const regularEmployee = employees.find((employee) => {
        const position = (employee.position || '').toLowerCase();
        return !managerKeywords.some((keyword) => position.includes(keyword.toLowerCase()));
      });

      if (regularEmployee) {
        setSelectedEmployeeId(regularEmployee.id);
      } else if (employees.length > 0) {
        setSelectedEmployeeId(employees[0].id);
      }
    }
  }, [employees, selectedEmployeeId]);

  const employeeLeaveDataKey = selectedEmployee
    ? JSON.stringify({
        id: selectedEmployee.id,
        d: selectedEmployee.specialLeaveDays,
        r: selectedEmployee.specialLeaveWorkDateRange,
        u: selectedEmployee.specialLeaveUsedDates,
        cd: selectedEmployee.specialLeaveCashDays,
        cm: selectedEmployee.specialLeaveCashMonth,
        n: selectedEmployee.specialLeaveNotes
      })
    : null;

  useEffect(() => {
    if (selectedEmployee) {
      setSpecialLeaveDays(selectedEmployee.specialLeaveDays || 0);
      setWorkDateRange(selectedEmployee.specialLeaveWorkDateRange || '');
      setUsedDates(selectedEmployee.specialLeaveUsedDates || []);
      setCashDays(selectedEmployee.specialLeaveCashDays || 0);
      setCashMonth(selectedEmployee.specialLeaveCashMonth || '');
      setNotes(selectedEmployee.specialLeaveNotes || '');
    } else {
      setSpecialLeaveDays(0);
      setWorkDateRange('');
      setUsedDates([]);
      setCashDays(0);
      setCashMonth('');
      setNotes('');
    }
  }, [employeeLeaveDataKey, selectedEmployeeId]);

  const saveUsedDates = async (newDates: string[]) => {
    if (!selectedEmployeeId || !isAdmin) return;

    setIsSaving(true);
    try {
      await apiRequest('PATCH', `/api/employees/${selectedEmployeeId}`, {
        specialLeaveDays,
        specialLeaveWorkDateRange: workDateRange,
        specialLeaveUsedDates: newDates,
        specialLeaveCashDays: cashDays,
        specialLeaveCashMonth: cashMonth,
        specialLeaveNotes: notes
      });

      queryClient.invalidateQueries({ queryKey: ['/api/employees'] });
      queryClient.invalidateQueries({ queryKey: ['/api/employees/admin'] });
      queryClient.invalidateQueries({ queryKey: ['/api/holidays'] });
      queryClient.invalidateQueries({ queryKey: ['/api/attendance'] });

      toast({
        title: "儲存成功",
        description: "特別假資料已更新，假日設定與考勤表已同步",
      });
    } catch (error) {
      console.error('Error saving special leave:', error);
      toast({
        title: "儲存失敗",
        description: "無法更新特別假資料",
        variant: "destructive"
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddLeaveDate = () => {
    if (!newLeaveDate) return;

    if (usedDates.includes(newLeaveDate)) {
      toast({
        title: "日期已存在",
        description: "此日期已經選取過了",
        variant: "destructive"
      });
      return;
    }

    const newDates = [...usedDates, newLeaveDate].sort();
    setUsedDates(newDates);
    setNewLeaveDate('');
    void saveUsedDates(newDates);
  };

  const handleRemoveLeaveDate = (date: string) => {
    const newDates = usedDates.filter((value) => value !== date);
    setUsedDates(newDates);
    void saveUsedDates(newDates);
  };

  const handleSave = async () => {
    await saveUsedDates(usedDates);
  };

  const remainingDays = specialLeaveDays - usedDates.length - cashDays;
  const dailySalary = Math.round(baseSalary / 30);
  const cashAmount = cashDays * dailySalary;

  const months: string[] = [];
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year <= currentYear + 1; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      months.push(`${year}年${month}月`);
    }
  }

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-medium">
          <Calendar className="h-5 w-5 text-blue-600" />
          特別假計數器
        </h3>
      </div>

      <div className="mb-6 rounded-md border border-blue-200 bg-blue-50 p-4">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-5 w-5 text-blue-600" />
          <div className="text-sm text-blue-800">
            <p className="mb-2 font-medium">採用「週年制」計算特別假</p>
            <p className="leading-6">
              請使用勞工局特別假試算工具計算您的特別假天數：
              <a
                href="https://calc.mol.gov.tw/Trail_New/html/RestDays.html"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 inline-flex items-center text-blue-600 underline hover:text-blue-800"
              >
                勞工局特別假試算
                <ExternalLink className="ml-1 h-3 w-3" />
              </a>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <Label>選擇員工</Label>
          <Select
            value={selectedEmployeeId?.toString() || ''}
            onValueChange={(value) => setSelectedEmployeeId(value ? parseInt(value, 10) : null)}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue placeholder="請選擇員工" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((employee) => (
                <SelectItem key={employee.id} value={employee.id.toString()}>
                  {employee.name} {employee.position ? `(${employee.position})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedEmployeeId && selectedEmployee && (
          <>
            <div className="rounded-xl border border-green-200 bg-green-50 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm text-green-800">
                    <span className="font-semibold">{selectedEmployee.name}</span>
                    {selectedEmployee.position && (
                      <span className="ml-2 text-green-600">({selectedEmployee.position})</span>
                    )}
                    <span className="ml-2 text-green-700">的特別假資料</span>
                  </p>
                  <p className="mt-1 text-xs text-green-600">
                    每位員工的特別假資料獨立儲存，切換員工即可查看/編輯不同員工的記錄
                  </p>
                </div>
                <div className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-green-700">
                  核定特休 {specialLeaveDays} 天
                </div>
              </div>
            </div>

            <div>
              <Label>工作日計算範圍</Label>
              <Input
                value={workDateRange}
                onChange={(e) => setWorkDateRange(e.target.value)}
                disabled={!isAdmin}
                className="mt-1"
                placeholder="例：2025/01/01-2026/01/01"
              />
            </div>

            <div className="rounded-xl border border-gray-200 p-4">
              <Label className="mb-2 block">使用特別假日期</Label>
              <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  type="date"
                  value={newLeaveDate}
                  onChange={(e) => setNewLeaveDate(e.target.value)}
                  disabled={!isAdmin}
                  className="flex-1"
                />
                <Button
                  onClick={handleAddLeaveDate}
                  disabled={!isAdmin || !newLeaveDate}
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  新增日期
                </Button>
              </div>

              {usedDates.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {usedDates.map((date) => (
                    <div
                      key={date}
                      className="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-sm text-green-800"
                    >
                      {date}
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveLeaveDate(date)}
                          className="ml-1 hover:text-red-600"
                          aria-label={`刪除 ${date}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">尚未選擇使用日期</p>
              )}

              <p className="mt-2 text-xs text-gray-500">已使用 {usedDates.length} 天</p>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="mb-3 flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-amber-600" />
                <Label>特別假折抵日薪</Label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-gray-500">折抵天數</Label>
                  <Select
                    value={cashDays.toString()}
                    onValueChange={(value) => setCashDays(parseInt(value, 10))}
                    disabled={!isAdmin}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue placeholder="選擇天數" />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }, (_, index) => (
                        <SelectItem key={index} value={index.toString()}>
                          {index} 天
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-gray-500">發放月份</Label>
                  <Select
                    value={cashMonth}
                    onValueChange={setCashMonth}
                    disabled={!isAdmin}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue placeholder="選擇發放月份" />
                    </SelectTrigger>
                    <SelectContent>
                      {months.map((month) => (
                        <SelectItem key={month} value={month}>
                          {month}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-3 rounded border bg-white p-3">
                <p className="text-sm">
                  折抵金額：<span className="font-bold text-amber-700">${cashAmount.toLocaleString()}</span>
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {cashDays}天 × ${dailySalary}/日
                </p>
              </div>
            </div>

            <div>
              <Label>備註</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!isAdmin}
                className="mt-1"
                placeholder="特別假相關備註..."
                rows={2}
              />
            </div>

            <div className="rounded-xl bg-gray-100 p-4">
              <div className="grid grid-cols-1 gap-3 text-center sm:grid-cols-3">
                <div className="rounded-lg bg-white p-3">
                  <p className="text-xs text-gray-500">特休剩餘天數</p>
                  <p className={`text-xl font-bold ${remainingDays < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {remainingDays} 天
                  </p>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <p className="text-xs text-gray-500">已使用特休</p>
                  <p className="text-xl font-bold text-blue-600">{usedDates.length} 天</p>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <p className="text-xs text-gray-500">折抵日薪</p>
                  <p className="text-xl font-bold text-amber-600">{cashDays} 天</p>
                </div>
              </div>
            </div>

            {isAdmin && (
              <Button
                onClick={handleSave}
                disabled={isSaving}
                className="w-full"
              >
                {isSaving ? '儲存中...' : '儲存特別假設定'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
