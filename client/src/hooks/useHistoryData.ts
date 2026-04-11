import { useCallback } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAdmin } from '@/hooks/useAdmin';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/use-toast';
import { extractListData, type PaginatedPayload } from '@/lib/paginatedPayload';
import { apiRequest } from '@/lib/queryClient';
import { calculateOvertime } from '@/lib/salaryCalculations';
import { debugLog } from '@/lib/debug';

interface SalaryRecord {
  id: number;
  salaryYear: number;
  salaryMonth: number;
  employeeId?: number;
  employeeName?: string;
  baseSalary: number;
  housingAllowance?: number;
  welfareAllowance?: number;
  allowances?: Array<{ name: string; amount: number; description?: string }>;
  totalOT1Hours: number;
  totalOT2Hours: number;
  totalOvertimePay: number;
  holidayDays: number;
  holidayDailySalary?: number;
  totalHolidayPay: number;
  grossSalary: number;
  deductions: Array<{ name: string; amount: number }>;
  totalDeductions: number;
  netSalary: number;
  attendanceData: Array<{
    date: string;
    clockIn: string;
    clockOut: string;
    isHoliday: boolean;
  }>;
  createdAt: string;
}

function safeNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? 0 : numericValue;
}

export function useHistoryData() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAdmin();
  const { settings } = useSettings();

  const {
    data: rawSalaryRecords = [],
    isLoading,
    error,
    refetch
  } = useQuery<SalaryRecord[] | PaginatedPayload<SalaryRecord>>({
    queryKey: ['/api/salary-records'],
    enabled: isAdmin
  });

  const salaryRecords = extractListData(rawSalaryRecords);

  const deleteSalaryRecordMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/salary-records/${id}`, undefined);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/salary-records'] });
      toast({
        title: 'Delete successful',
        description: 'The salary record was deleted.',
      });
    },
    onError: (mutationError) => {
      console.error('Error deleting salary record:', mutationError);
      toast({
        title: 'Delete failed',
        description: 'Unable to delete the salary record.',
        variant: 'destructive'
      });
    }
  });

  const updateSalaryRecordMutation = useMutation({
    mutationFn: async ({
      id,
      data,
      skipRecalculation = false
    }: {
      id: number;
      data: Partial<Omit<SalaryRecord, 'id' | 'createdAt'>>;
      skipRecalculation?: boolean;
    }) => {
      const response = await apiRequest(
        'PATCH',
        `/api/salary-records/${id}`,
        data,
        skipRecalculation
          ? {
              headers: {
                'x-force-update': 'true'
              }
            }
          : undefined
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/salary-records'] });
      debugLog('Salary record updated');
    },
    onError: (mutationError) => {
      console.error('Error updating salary record:', mutationError);
      toast({
        title: 'Update failed',
        description: 'Unable to update the salary record.',
        variant: 'destructive'
      });
    }
  });

  const deleteSalaryRecord = useCallback(
    async (id: number) => deleteSalaryRecordMutation.mutateAsync(id),
    [deleteSalaryRecordMutation]
  );

  const updateSalaryRecord = useCallback(
    async (
      id: number,
      data: Partial<Omit<SalaryRecord, 'id' | 'createdAt'>>,
      skipRecalculation = true
    ) => updateSalaryRecordMutation.mutateAsync({ id, data, skipRecalculation }),
    [updateSalaryRecordMutation]
  );

  const getSalaryRecordById = useCallback(
    async (id: number) => {
      if (!isAdmin) {
        throw new Error('Admin privileges are required to read salary records.');
      }

      const response = await apiRequest('GET', `/api/salary-records/${id}`, undefined);
      const record = (await response.json()) as SalaryRecord;
      debugLog('Loaded salary record', { id, netSalary: record.netSalary });
      return record;
    },
    [isAdmin]
  );

  const exportSalaryRecordAsCsv = useCallback((record: SalaryRecord) => {
    try {
      let csvContent = `Salary record - ${record.salaryYear}/${record.salaryMonth}\n`;
      csvContent += `Employee,${record.employeeName || ''}\n`;
      csvContent += `Year,${record.salaryYear}\n`;
      csvContent += `Month,${record.salaryMonth}\n\n`;

      csvContent += 'Summary\n';
      csvContent += `Base salary,${safeNumber(record.baseSalary)}\n`;
      csvContent += `Housing allowance,${safeNumber(record.housingAllowance)}\n`;
      csvContent += `Welfare allowance,${safeNumber(record.welfareAllowance)}\n`;
      csvContent += `OT1 hours,${safeNumber(record.totalOT1Hours)}\n`;
      csvContent += `OT2 hours,${safeNumber(record.totalOT2Hours)}\n`;
      csvContent += `Overtime pay,${safeNumber(record.totalOvertimePay)}\n`;
      csvContent += `Holiday days,${safeNumber(record.holidayDays)}\n`;
      csvContent += `Holiday pay,${safeNumber(record.totalHolidayPay)}\n`;
      csvContent += `Gross salary,${safeNumber(record.grossSalary)}\n`;
      csvContent += `Deductions,${safeNumber(record.totalDeductions)}\n`;
      csvContent += `Net salary,${safeNumber(record.netSalary)}\n\n`;

      csvContent += 'Deductions detail\n';
      csvContent += 'Name,Amount\n';
      (record.deductions || []).forEach((deduction) => {
        csvContent += `${deduction.name || ''},${safeNumber(deduction.amount)}\n`;
      });

      csvContent += '\nAttendance\n';
      csvContent += 'Date,Clock In,Clock Out,Holiday,OT1 Hours,OT2 Hours,Daily OT Pay\n';

      (record.attendanceData || []).forEach((attendance) => {
        const { ot1, ot2 } = calculateOvertime(attendance.clockIn, attendance.clockOut);
        const baseHourlyRate = settings?.baseHourlyRate ?? 119;
        const ot1HourlyRate = baseHourlyRate * (settings?.ot1Multiplier ?? 1.34);
        const ot2HourlyRate = baseHourlyRate * (settings?.ot2Multiplier ?? 1.67);
        const safeOt1 = Number.isNaN(ot1) ? 0 : ot1;
        const safeOt2 = Number.isNaN(ot2) ? 0 : ot2;
        const dailyOTPay = Math.round(ot1HourlyRate * safeOt1 + ot2HourlyRate * safeOt2);

        csvContent += `${attendance.date || ''},${attendance.clockIn || ''},${attendance.clockOut || ''},${attendance.isHoliday ? 'Yes' : 'No'},${safeOt1.toFixed(1)},${safeOt2.toFixed(1)},${safeNumber(dailyOTPay)}\n`;
      });

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `salary-record_${record.employeeName || 'employee'}_${record.salaryYear}_${record.salaryMonth}.csv`;
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(link);
        toast({
          title: 'Export successful',
          description: 'The salary record was exported as CSV.',
        });
      }, 500);
    } catch (mutationError) {
      console.error('Error exporting salary record as CSV:', mutationError);
      toast({
        title: 'Export failed',
        description: 'Unable to export the salary record.',
        variant: 'destructive'
      });
    }
  }, [toast]);

  return {
    salaryRecords,
    isLoading,
    refetch,
    getSalaryRecordById,
    exportSalaryRecordAsCsv,
    deleteSalaryRecord,
    updateSalaryRecord,
    isDeletingRecord: deleteSalaryRecordMutation.isPending,
    isUpdatingRecord: updateSalaryRecordMutation.isPending
  };
}
