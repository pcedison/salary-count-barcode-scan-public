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
import { calculateDailyOvertimePay, calculateOvertime } from '@/lib/salaryCalculations';
import { parseSalaryRecordId } from '@/lib/printSalary';

interface SalaryRecordWithExtras {
  id: number;
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
    holidayType?: 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave' | null;
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
    if (!salaryRecord) return;

    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      toast({
        title: '無法開啟列印視窗',
        description: '請確認瀏覽器沒有封鎖彈出視窗，然後再試一次。',
        variant: 'destructive',
      });
      return;
    }

    document.querySelectorAll('style').forEach((styleElement) => {
      if (styleElement.textContent?.includes('@media print')) {
        styleElement.setAttribute('media', 'print');
      }
    });

    const sortedAttendance = [...(salaryRecord.attendanceData ?? [])].sort((a, b) => {
      return new Date(a.date.replace(/\//g, '-')).getTime() - new Date(b.date.replace(/\//g, '-')).getTime();
    });

    let totalOT1 = 0;
    let totalOT2 = 0;
    let totalOTPay = 0;

    const getDeduction = (name: string): number => {
      const item = (salaryRecord.deductions ?? []).find((deduction: { name: string; amount: number }) => deduction.name === name);
      return item ? item.amount : 0;
    };

    const calculateDailyOT = (clockIn: string, clockOut: string): { ot1: number; ot2: number; pay: number } => {
      if (!clockIn || !clockOut || clockIn === '--:--' || clockOut === '--:--') {
        return { ot1: 0, ot2: 0, pay: 0 };
      }

      const { ot1, ot2 } = calculateOvertime(clockIn, clockOut);
      const pay = calculateDailyOvertimePay(clockIn, clockOut, salaryRecord.baseSalary);

      return { ot1, ot2, pay };
    };

    let attendanceRowsHtml = '';

    sortedAttendance.forEach((record) => {
      const dailyOT = calculateDailyOT(record.clockIn, record.clockOut);
      const ot1 = dailyOT.ot1;
      const ot2 = dailyOT.ot2;
      const pay = dailyOT.pay;

      totalOT1 += ot1;
      totalOT2 += ot2;
      totalOTPay += pay;

      const isHolidayClass = record.isHoliday ? 'holiday-row' : '';

      attendanceRowsHtml += `
<tr class="${isHolidayClass}">
  <td class="date-cell">${record.date}</td>
  <td class="time-cell">${record.clockIn}</td>
  <td class="time-cell">${record.clockOut}</td>
  <td class="number-cell">${ot1.toFixed(1)}</td>
  <td class="number-cell">${ot2.toFixed(1)}</td>
  <td class="amount-cell">${pay}</td>
</tr>`;
    });

    let summaryRowsHtml = `
<tr class="summary-row">
  <td colspan="3">加班費合計</td>
  <td class="number-cell">${totalOT1.toFixed(1)}</td>
  <td class="number-cell">${totalOT2.toFixed(1)}</td>
  <td class="amount-cell">${totalOTPay}</td>
</tr>`;

    if (salaryRecord.paidLeaveDays && salaryRecord.paidLeaveDays > 0) {
      summaryRowsHtml += `
<tr class="summary-size-row">
  <td colspan="5">有薪假</td>
  <td class="amount-cell">${salaryRecord.paidLeaveDays} 天（已給薪）</td>
</tr>`;
    }

    summaryRowsHtml += `
<tr class="summary-size-row">
  <td colspan="5">假日出勤加給</td>
  <td class="amount-cell">${(salaryRecord.holidayDays ?? 0) > 0 ? salaryRecord.totalHolidayPay : '0'}</td>
</tr>
<tr class="base-salary-row">
  <td colspan="5">基本薪資</td>
  <td class="amount-cell">${salaryRecord.baseSalary}</td>
</tr>`;

    if (salaryRecord.housingAllowance && salaryRecord.housingAllowance > 0) {
      summaryRowsHtml += `
<tr class="summary-size-row">
  <td colspan="5">住宿津貼</td>
  <td class="amount-cell">${salaryRecord.housingAllowance}</td>
</tr>`;
    }

    if (salaryRecord.allowances && salaryRecord.allowances.length > 0) {
      salaryRecord.allowances.forEach((allowance: { name: string; amount: number }) => {
        if (allowance.amount > 0) {
          summaryRowsHtml += `
<tr class="summary-size-row welfare-row" style="font-weight: bold;">
  <td colspan="5">${allowance.name}</td>
  <td class="amount-cell">${allowance.amount}</td>
</tr>`;
        }
      });
    } else if (salaryRecord.welfareAllowance && salaryRecord.welfareAllowance > 0) {
      summaryRowsHtml += `
<tr class="summary-size-row welfare-row" style="font-weight: bold;">
  <td colspan="5">福利津貼</td>
  <td class="amount-cell">${salaryRecord.welfareAllowance}</td>
</tr>`;
    }

    if (salaryRecord.deductions && salaryRecord.deductions.length > 0) {
      salaryRecord.deductions.forEach((deduction: { name: string; amount: number }) => {
        if (deduction.amount > 0) {
          summaryRowsHtml += `
<tr class="deduction-row summary-size-row">
  <td colspan="5">${deduction.name}</td>
  <td class="amount-cell">-${deduction.amount}</td>
</tr>`;
        }
      });
    }

    const personalLeaveDeduction = getDeduction('事假');
    if (personalLeaveDeduction > 0) {
      debugLog(`Personal leave deduction applied: ${personalLeaveDeduction}`);
    }

    summaryRowsHtml += `
<tr class="total-amount summary-size-row">
  <td colspan="5">實發薪資</td>
  <td class="amount-cell">${salaryRecord.netSalary}</td>
</tr>`;

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <title>${salaryRecord.salaryYear}年${salaryRecord.salaryMonth}月薪資單</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      background-color: white;
    }

    @page {
      size: A4 portrait;
      margin: 0;
    }

    @media print {
      body {
        background-color: white;
      }

      .print-page, .print-page * {
        visibility: visible !important;
        color-adjust: exact !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      table, tr, td, th, tbody, thead {
        page-break-inside: avoid !important;
      }
    }

    .print-page {
      width: 210mm;
      height: 297mm;
      padding: 10mm;
      box-sizing: border-box;
      margin: 0 auto;
      background-color: white;
    }

    .header-section {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-bottom: 10px;
    }

    .system-title {
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 4px;
    }

    .month-title {
      font-size: 32px;
      font-weight: bold;
      margin-top: 0;
      line-height: 1;
    }

    .calculation-label {
      text-align: right;
      font-size: 14px;
      color: #666;
    }

    .salary-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      margin: 0;
    }

    .salary-table th, .salary-table td {
      border: 1px solid #000;
      padding: 2px 5px;
      text-align: left;
      height: 22px;
      line-height: 1.2;
    }

    .salary-table th {
      font-weight: normal;
      background-color: #f8f8f8;
      text-align: center;
    }

    .number-cell {
      text-align: center;
      white-space: nowrap;
    }

    .amount-cell {
      text-align: right;
      white-space: nowrap;
      font-family: monospace;
    }

    .date-cell {
      white-space: nowrap;
    }

    .time-cell {
      white-space: nowrap;
      text-align: center;
    }

    .holiday-row {
      color: red;
    }

    .summary-row {
      background-color: #f9f9f9;
      font-weight: 500;
    }

    .deduction-row td:last-child {
      color: #e53935;
    }

    .total-amount {
      font-weight: bold;
    }

    .salary-table tr:nth-child(even):not(.deduction-row):not(.summary-row):not(.total-amount) {
      background-color: #fcfcfc;
    }

    @media print {
      .print-button {
        display: none;
      }
    }

    .print-button {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 8px 16px;
      background-color: #0f172a;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }

    .print-button:hover {
      background-color: #1e293b;
    }
  </style>
</head>
<body>
  <button class="print-button" onclick="window.print(); setTimeout(() => window.close(), 500);">列印</button>
  <div class="print-page">
    <div class="header-section">
      <div>
        <h1 class="system-title">員工薪資計算系統</h1>
        <h2 class="month-title">${salaryRecord.salaryMonth} 月薪資單</h2>
      </div>
      <div>
        <span class="calculation-label">薪資明細</span>
      </div>
    </div>

    <table class="salary-table">
      <thead>
        <tr>
          <th style="width: 90px;">日期</th>
          <th style="width: 70px;">上班時間</th>
          <th style="width: 70px;">下班時間</th>
          <th style="width: 90px;">OT1 時數</th>
          <th style="width: 90px;">OT2 時數</th>
          <th style="width: 110px;">加班費/假日加給</th>
        </tr>
      </thead>
      <tbody>
${attendanceRowsHtml}${summaryRowsHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    printWindow.document.open();
    printWindow.document.write(fullHtml);
    printWindow.document.close();

    if (navigator.userAgent.includes('Chrome')) {
      setTimeout(() => {
        printWindow.focus();
      }, 250);
    } else {
      printWindow.focus();
    }
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
    <div className="pb-8">
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

      <PrintableSalarySheet result={{
        salaryYear: salaryRecord.salaryYear,
        salaryMonth: salaryRecord.salaryMonth,
        baseSalary: salaryRecord.baseSalary,
        grossSalary: salaryRecord.grossSalary,
        netSalary: salaryRecord.netSalary,
        housingAllowance: salaryRecord.housingAllowance ?? undefined,
        welfareAllowance: salaryRecord.welfareAllowance ?? undefined,
        allowances: (salaryRecord.allowances ?? undefined) as typeof salaryRecord.allowances & NonNullable<unknown> | undefined,
        totalOT1Hours: salaryRecord.totalOT1Hours ?? 0,
        totalOT2Hours: salaryRecord.totalOT2Hours ?? 0,
        totalOvertimePay: salaryRecord.totalOvertimePay ?? 0,
        holidayDays: salaryRecord.holidayDays ?? 0,
        totalHolidayPay: salaryRecord.totalHolidayPay ?? 0,
        deductions: salaryRecord.deductions ?? [],
        totalDeductions: salaryRecord.totalDeductions ?? 0,
        specialLeaveInfo: salaryRecord.specialLeaveInfo ?? undefined,
        attendanceData: (salaryRecord.attendanceData ?? []).map(r => ({
          ...r,
          holidayType: r.holidayType ?? undefined
        }))
      }} />
    </div>
  );
}
