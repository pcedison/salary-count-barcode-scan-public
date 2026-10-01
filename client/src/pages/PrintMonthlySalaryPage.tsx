import { useEffect, useMemo, useState } from 'react';

import PrintableSalarySheet from '@/components/PrintableSalarySheet';
import { parseSalaryRecordIds, toPrintableSalarySnapshot } from '@/lib/printSalary';

interface SalaryRecordForPrint {
  id: number;
  revision?: number;
  employeeId?: number | null;
  employeeName?: string | null;
  salaryYear: number;
  salaryMonth: number;
  baseSalary: number;
  housingAllowance?: number | null;
  welfareAllowance?: number | null;
  allowances?: Array<{ name: string; amount: number; description?: string }> | null;
  totalOT1Hours?: number | null;
  totalOT2Hours?: number | null;
  totalOvertimePay?: number | null;
  holidayDays?: number | null;
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
}



export default function PrintMonthlySalaryPage() {
  const ids = useMemo(() => parseSalaryRecordIds(window.location.search), []);
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const [records, setRecords] = useState<SalaryRecordForPrint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0 || !token) {
      setError('Missing salary print token.');
      return;
    }

    const controller = new AbortController();
    const loadRecords = async () => {
      try {
        const params = new URLSearchParams({
          ids: ids.join(','),
          token,
        });
        const response = await fetch(`/api/salary-records/print-batch?${params.toString()}`, {
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Unable to load salary records: ${response.status}`);
        }

        const payload = await response.json();
        setRecords(Array.isArray(payload.records) ? payload.records : []);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };

    void loadRecords();

    return () => controller.abort();
  }, [ids, token]);

  if (error) {
    return (
      <div data-print-ready="error" className="p-8 text-center text-sm text-red-600">
        {error}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div data-print-ready="false" className="p-8 text-center text-sm text-gray-500">
        Loading salary records...
      </div>
    );
  }

  return (
    <div data-print-ready="true" className="monthly-print-root">
      {records.map((record) => (
        <PrintableSalarySheet key={record.id} result={toPrintableSalarySnapshot(record)} />
      ))}
      <style>
        {`
        @media screen {
          .monthly-print-root {
            background: #f3f4f6;
            padding: 16px 0;
          }

          .monthly-print-root .print-container + .print-container {
            margin-top: 16px;
          }
        }

        @media print {
          .monthly-print-root {
            padding: 0 !important;
            background: white !important;
          }
        }
        `}
      </style>
    </div>
  );
}
