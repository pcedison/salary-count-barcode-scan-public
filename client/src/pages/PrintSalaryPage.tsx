import { useEffect, useState } from 'react';

import { useLocation } from 'wouter';
import { ArrowLeft, Lock, Printer, Shield } from 'lucide-react';
import AdminLoginDialog from '@/components/AdminLoginDialog';
import PrintableSalarySheet from '@/components/PrintableSalarySheet';
import { Button } from '@/components/ui/button';
import { useAdmin } from '@/hooks/useAdmin';
import { useToast } from '@/hooks/use-toast';
import { debugLog } from '@/lib/debug';
import { apiRequest } from '@/lib/queryClient';

import { parseSalaryRecordId, toPrintableSalarySnapshot } from '@/lib/printSalary';

interface SalaryRecordWithExtras {
  id: number;
  revision?: number;
  salaryYear: number;
  salaryMonth: number;
  employeeId?: number | null;
  employeeName?: string | null;
  baseSalary: number;
  housingAllowance?: number | null;
  welfareAllowance?: number | null;
  allowances?: Array<{ name: string; amount: number; description?: string }> | null;
  totalOT1Hours?: number | null;
  totalOT2Hours?: number | null;
  totalOvertimePay?: number | null;
  holidayDays?: number | null;
  holidayDailySalary?: number | null;
  totalHolidayPay?: number | null;
  grossSalary: number;
  deductions?: Array<{ name: string; amount: number }> | null;
  totalDeductions?: number | null;
  netSalary: number;
  attendanceData?: Array<{
    date: string;
    clockIn: string;
    clockOut: string;
    isHoliday: boolean;
    holidayType?: 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave' | 'special_leave_cash' | null;
  }> | null;
  specialLeaveInfo?: {
    usedDays: number;
    usedDates: string[];
    cashDays: number;
    cashAmount: number;
    notes?: string;
  } | null;
  paidLeaveDays?: number | null;
}

export default function PrintSalaryPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const [salaryRecord, setSalaryRecord] = useState<SalaryRecordWithExtras | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdminDialogOpen, setIsAdminDialogOpen] = useState(false);

  const recordId = parseSalaryRecordId(window.location.search);

  useEffect(() => {
    if (!recordId || Number.isNaN(recordId)) {
      debugLog('No valid record ID found, redirecting to history page');
      setLocation('/history');
      return;
    }

    if (!isAdmin) {
      setSalaryRecord(null);
      setIsLoading(false);
      return;
    }

    const loadSalaryRecord = async () => {
      try {
        setIsLoading(true);
        const response = await apiRequest('GET', `/api/salary-records/${recordId}`, undefined);
        const record = await response.json();
        setSalaryRecord(record);
      } catch (error) {
        console.error('Error loading salary record:', error);
        setLocation('/history');
      } finally {
        setIsLoading(false);
      }
    };

    void loadSalaryRecord();
  }, [isAdmin, recordId, setLocation]);

  const handlePrint = () => {
    if (salaryRecord) window.print();
  };

  const handleBack = () => {
    setLocation('/history');
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center rounded-2xl border bg-white p-10 text-center shadow-sm">
          <div className="mb-6 rounded-full bg-amber-100 p-4 text-amber-700">
            <Lock className="h-10 w-10" />
          </div>
          <h1 className="mb-3 text-2xl font-bold text-gray-900">需要管理員權限</h1>
          <p className="mb-8 max-w-lg text-gray-600">
            列印薪資單屬於管理功能。請先完成管理員驗證，再繼續查看或列印薪資資料。
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回歷史記錄
            </Button>
            <Button onClick={() => setIsAdminDialogOpen(true)}>
              <Shield className="mr-2 h-4 w-4" />
              管理員登入
            </Button>
          </div>

          <AdminLoginDialog
            isOpen={isAdminDialogOpen}
            onClose={() => setIsAdminDialogOpen(false)}
            onSuccess={() => {
              setIsAdminDialogOpen(false);
              toast({
                title: '管理員驗證成功',
                description: '你現在可以查看並列印薪資單。',
              });
            }}
            title="管理員登入"
            description="請輸入管理員 PIN 以查看或列印薪資單。"
          />
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!salaryRecord) {
    return (
      <div className="p-8 text-center">
        <h2 className="mb-4 text-xl font-bold">找不到薪資紀錄</h2>
        <Button onClick={handleBack}>返回歷史記錄</Button>
      </div>
    );
  }

  return (
    <div className="salary-print-root">
      <div className="no-print sticky top-0 z-10 mb-4 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回
          </Button>
          <div className="space-x-2">
            <Button onClick={handlePrint} className="bg-primary text-white hover:bg-primary/90">
              <Printer className="mr-2 h-4 w-4" />
              列印薪資單
            </Button>
          </div>
        </div>
      </div>

      <PrintableSalarySheet result={toPrintableSalarySnapshot(salaryRecord)} />
    </div>
  );
}
