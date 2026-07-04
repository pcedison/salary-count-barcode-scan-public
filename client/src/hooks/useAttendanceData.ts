import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/hooks/useAdmin';
import { apiRequest } from '@/lib/queryClient';
import { useSettings } from '@/hooks/useSettings';
import { useEmployees } from '@/hooks/useEmployees';
import { invalidateAttendanceQueries } from '@/lib/attendanceRecords';
import { debugLog } from '@/lib/debug';
import {
  getCurrentYearMonth,
  formatDate
} from '@/lib/utils';
import {
  calculateDailyOvertimeSummary,
  calculateGrossSalary,
  calculateNetSalary,
  normalizeSalarySettings
} from '@shared/utils/salaryMath';
import {
  getSpecialLeaveInfoForMonth as getSpecialLeaveInfoForMonthPure,
  toMonthKey,
  type AttendanceRecord
} from '@/lib/attendanceEnhancement';
import { useAttendanceQueries } from '@/hooks/useAttendanceQueries';

interface HolidayEntry {
  date: string;
  name?: string;
  holidayType?: string;
  employeeId?: number | null;
}

interface NewAttendanceRecord {
  employeeId?: number | null;
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
}

interface SalaryResult {
  salaryYear: number;
  salaryMonth: number;
  employeeId?: number;
  employeeName?: string;
  baseSalary: number;
  housingAllowance: number;
  welfareAllowance: number;
  allowances: Array<{ name: string; amount: number; description?: string }>;
  totalOT1Hours: number;
  totalOT2Hours: number;
  totalOvertimePay: number;
  paidLeaveDays?: number;
  paidLeavePay?: number;
  holidayDays: number;
  holidayDates?: string[];
  holidayDailySalary: number;
  totalHolidayPay: number;
  grossSalary: number;
  deductions: Array<{ name: string; amount: number }>;
  totalDeductions: number;
  netSalary: number;
  attendanceData: AttendanceRecord[];
  specialLeaveInfo?: {
    usedDays: number;
    usedDates: string[];
    cashDays: number;
    cashAmount: number;
    cashMonth?: string;
    notes?: string;
  };
}

/**
 * 出勤登記主 hook,由三層組成:
 * - lib/attendanceEnhancement:純函式(過濾/增強/排序,有單元測試)
 * - useAttendanceQueries:查詢軸(抓取、同步狀態、顯示資料)
 * - 本檔:mutations 與試算/結算工作流
 * 公開介面與拆分前完全一致。
 */
export function useAttendanceData() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAdmin();
  const { settings, holidays } = useSettings({ requireAdminSettings: isAdmin });
  const { employees } = useEmployees({ requireAdminDetails: isAdmin });

  const [salaryResult, setSalaryResult] = useState<SalaryResult | null>(null);

  const {
    attendanceData,
    sortedAttendanceData,
    isLoading,
    syncStatus,
    markSyncing
  } = useAttendanceQueries({
    isAdmin,
    employees,
    baseMonthSalary: settings?.baseMonthSalary || 29500
  });

  const getSpecialLeaveInfoForMonth = (employeeId: number, year: number, month: number) =>
    getSpecialLeaveInfoForMonthPure(
      employees?.find((emp) => emp.id === employeeId),
      year,
      month,
      settings?.baseMonthSalary || 29500
    );

  const createAttendanceMutation = useMutation({
    mutationFn: async (newRecord: NewAttendanceRecord) => {
      const formattedRecord = {
        ...newRecord,
        date: formatDate(newRecord.date) // Ensure date is in YYYY/MM/DD format
      };

      return await apiRequest('POST', '/api/attendance', formattedRecord);
    },
    onSuccess: () => {
      invalidateAttendanceQueries(queryClient);
    },
    onError: (error) => {
      console.error('Error adding attendance record:', error);
      toast({
        title: "Attendance create failed",
        description: error instanceof Error ? error.message : "Failed to create attendance record.",
        variant: "destructive"
      });
    }
  });

  // Update attendance record
  const updateAttendanceMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<NewAttendanceRecord> }) => {
      const formattedData = {
        ...data,
        date: data.date ? formatDate(data.date) : undefined
      };

      return await apiRequest('PUT', `/api/attendance/${id}`, formattedData);
    },
    onSuccess: () => {
      invalidateAttendanceQueries(queryClient);
    },
    onError: (error) => {
      console.error('Error updating attendance record:', error);
      toast({
        title: "Attendance update failed",
        description: error instanceof Error ? error.message : "Failed to update attendance record",
        variant: "destructive"
      });
    }
  });

  // Delete a single attendance record
  const deleteSingleAttendanceMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest('DELETE', `/api/attendance/${id}`);
    },
    onSuccess: () => {
      invalidateAttendanceQueries(queryClient);
    },
    onError: (error) => {
      console.error('Error deleting attendance record:', error);
      toast({
        title: "Attendance delete failed",
        description: error instanceof Error ? error.message : "Failed to delete attendance record",
        variant: "destructive"
      });
    }
  });

  // Delete attendance records with optional employee filter
  const deleteFilteredAttendanceMutation = useMutation({
    mutationFn: async ({ ids, employeeId }: { ids?: number[], employeeId?: number }) => {
      if (ids && ids.length > 0) {
        const deletePromises = ids.map(id => apiRequest('DELETE', `/api/attendance/${id}`));
        return Promise.all(deletePromises);
      } else if (employeeId !== undefined) {
        return await apiRequest('DELETE', `/api/attendance/employee/${employeeId}`);
      } else {
        return await apiRequest('DELETE', '/api/attendance');
      }
    },
    onSuccess: () => {
      invalidateAttendanceQueries(queryClient);
    },
    onError: (error) => {
      console.error('Error deleting attendance records:', error);
      toast({
        title: "Attendance clear failed",
        description: error instanceof Error ? error.message : "Failed to clear attendance records.",
        variant: "destructive"
      });
    }
  });

  // Create salary record
  const createSalaryRecordMutation = useMutation({
    mutationFn: async (salaryRecord: SalaryResult) => {
      return await apiRequest('POST', '/api/salary-records', salaryRecord);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/salary-records'] });
    },
    onError: (error) => {
      console.error('Error creating salary record:', error);
      toast({
        title: "Salary save failed",
        description: error instanceof Error ? error.message : "Failed to save salary record.",
        variant: "destructive"
      });
    }
  });

  // Add a new attendance record
  const addAttendance = async (record: NewAttendanceRecord) => {
    try {
      markSyncing();
      await createAttendanceMutation.mutateAsync(record);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Update an attendance record
  const updateAttendance = async (id: number, data: Partial<NewAttendanceRecord>) => {
    try {
      markSyncing();
      await updateAttendanceMutation.mutateAsync({ id, data });
      return true;
    } catch (error) {
      return false;
    }
  };

  // Delete an attendance record
  const deleteAttendance = async (id: number) => {
    try {
      markSyncing();
      await deleteSingleAttendanceMutation.mutateAsync(id);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Clear all attendance records
  const clearAllData = async () => {
    try {
      markSyncing();
      await deleteFilteredAttendanceMutation.mutateAsync({});
      setSalaryResult(null);
      return true;
    } catch (error) {
      return false;
    }
  };

  const calculateSalary = (dataToUse?: AttendanceRecord[]) => {
    const recordsToProcess = dataToUse || attendanceData;

    if (!Array.isArray(recordsToProcess) || recordsToProcess.length === 0 || !settings) {
      toast({
        title: "Salary calculation failed",
        description: "No attendance records or settings were provided.",
        variant: "destructive"
      });
      return null;
    }

    try {
      const calculationSettings = normalizeSalarySettings(settings);
      const baseMonthSalary = calculationSettings.baseMonthSalary ?? 0;
      const welfareAllowance = calculationSettings.welfareAllowance ?? 0;
      const housingAllowance = 0;
      const deductions = settings.deductions || [];
      const allowances = settings.allowances || [{ name: "福利津貼", amount: welfareAllowance, description: "員工福利津貼" }];

      const sortedData = [...recordsToProcess].sort((a, b) => {
        const dateA = a.date.split("/").map(Number);
        const dateB = b.date.split("/").map(Number);

        if (dateA[0] !== dateB[0]) return dateA[0] - dateB[0];
        if (dateA[1] !== dateB[1]) return dateA[1] - dateB[1];
        return dateA[2] - dateB[2];
      });

      let salaryYear: number;
      let salaryMonth: number;

      if (sortedData.length > 0) {
        const firstRecordDate = sortedData[0].date.split("/");
        salaryYear = parseInt(firstRecordDate[0]);
        salaryMonth = parseInt(firstRecordDate[1]);
      } else {
        const { year, month } = getCurrentYearMonth();
        salaryYear = year;
        salaryMonth = month;
      }

      const firstWithEmployee = sortedData.find((r) => r.employeeId);
      const employeeInfo = firstWithEmployee
        ? {
            employeeId: firstWithEmployee.employeeId!,
          employeeName: firstWithEmployee._employeeName || 'Unknown employee'
        }
        : { employeeId: 0, employeeName: 'Unknown employee' };

      const employeeId = employeeInfo.employeeId as number;
      const specialLeaveInfo = employeeId
        ? getSpecialLeaveInfoForMonth(employeeId, salaryYear, salaryMonth)
        : null;
      const specialLeaveCashAmount = specialLeaveInfo?.cashAmount || 0;
      const payrollAttendanceData = sortedData.filter((day) => !day._isSpecialLeaveCashRecord);
      const normalDays = payrollAttendanceData.filter((day) => !day.isHoliday);
      const holidayDays = payrollAttendanceData.filter((day) => day.isHoliday);

      let totalOT1Hours = 0;
      let totalOT2Hours = 0;
      let totalOvertimePay = 0;

      const dailyOvertimeDetails = normalDays.map((day) => {
        const summary = calculateDailyOvertimeSummary(day.clockIn, day.clockOut, calculationSettings);
        totalOT1Hours += summary.ot1;
        totalOT2Hours += summary.ot2;
        totalOvertimePay += summary.pay;

        return {
          date: day.date,
          clockIn: day.clockIn,
          clockOut: day.clockOut,
          ot1Hours: summary.ot1,
          ot2Hours: summary.ot2,
          ot1Pay: Math.round(summary.ot1 * calculationSettings.baseHourlyRate * calculationSettings.ot1Multiplier),
          ot2Pay: Math.round(summary.ot2 * calculationSettings.baseHourlyRate * calculationSettings.ot2Multiplier),
          dailyTotal: summary.pay
        };
      });

      debugLog("dailyOvertimeDetails", dailyOvertimeDetails);
      debugLog("totalOvertimePay", totalOvertimePay);

      debugLog("holidayDays", holidayDays.map((day) => ({
        date: day.date,
        clockIn: day.clockIn,
        clockOut: day.clockOut,
        isHoliday: day.isHoliday,
        dayOfWeek: new Date(day.date).getDay()
      })));

      const salaryMonthKey = `${salaryYear}-${String(salaryMonth).padStart(2, '0')}`;
      const employeeHolidays = Array.isArray(holidays)
        ? holidays.filter((h: HolidayEntry) =>
            (!h.employeeId || h.employeeId === employeeId) &&
            toMonthKey(h.date) === salaryMonthKey
          )
        : [];
      debugLog("employeeHolidays", employeeHolidays.map((h) => ({ date: h.date, name: h.name })));

      const actualHolidayWork = payrollAttendanceData.filter((day) => {
        if (!day.clockIn || !day.clockOut || day.clockIn === "" || day.clockOut === "" || day.clockIn === "--:--" || day.clockOut === "--:--") {
          return false;
        }

        const holidayRecord = employeeHolidays.find((h) => h.date === day.date);
        if (holidayRecord) {
          return holidayRecord.holidayType === "worked";
        }

        if (day.holidayType && day.holidayType !== "worked" && day.holidayType !== "none") {
          return false;
        }

        const dayOfWeek = new Date(day.date).getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        return isWeekend;
      });

      const paidLeave = employeeHolidays.filter((h) => {
        const hasAttendanceRecord = payrollAttendanceData.some((day) =>
          day.date === h.date && day.clockIn && day.clockOut && day.clockIn !== "" && day.clockOut !== ""
        );
        return !hasAttendanceRecord;
      });

      debugLog("paidLeave", paidLeave.length);
      debugLog("actualHolidayWork", actualHolidayWork.length, actualHolidayWork.map((d) => d.date));

      const holidayDailySalary = Math.ceil(baseMonthSalary / 30);
      const totalHolidayPay = actualHolidayWork.length * holidayDailySalary;
      const dailyWage = Math.round(baseMonthSalary / 30);
      const hourlyWage = Math.round(dailyWage / 8);
      const leaveDeductions: { name: string; amount: number }[] = [];

      payrollAttendanceData.forEach((day) => {
        const holidayType = day.holidayType;
        if (!holidayType || holidayType === "none" || holidayType === "worked" || holidayType === "national_holiday") {
          return;
        }

        const isFullDay = !day.clockIn || !day.clockOut || day.clockIn === "--:--" || day.clockOut === "--:--";

        switch (holidayType) {
          case "typhoon_leave":
            leaveDeductions.push({
              name: `typhoon_leave (${day.date})`,
              amount: dailyWage
            });
            break;
          case "temporary_stop_work_and_classes":
            leaveDeductions.push({
              name: `temporary_stop_work_and_classes (${day.date})`,
              amount: dailyWage
            });
            break;
          case "sick_leave":
            if (isFullDay) {
              leaveDeductions.push({
                name: `sick_leave (${day.date})`,
                amount: Math.round(dailyWage * 0.5),
              });
            }
            break;
          case "personal_leave":
            if (isFullDay) {
              leaveDeductions.push({
                name: `personal_leave (${day.date})`,
                amount: dailyWage,
              });
            }
            break;
        }
      });

      debugLog("leaveDeductions", leaveDeductions);

      const allDeductions = [...deductions, ...leaveDeductions];
      const grossSalary =
        calculateGrossSalary(
          baseMonthSalary,
          totalOvertimePay,
          totalHolidayPay,
          welfareAllowance,
          housingAllowance
        ) + specialLeaveCashAmount;
      const totalDeductions = allDeductions.reduce((sum: number, deduction: { name: string; amount: number }) => sum + deduction.amount, 0);
      const netSalary = calculateNetSalary(grossSalary, totalDeductions);

      const result: SalaryResult = {
        salaryYear,
        salaryMonth,
        employeeId: employeeInfo.employeeId,
        employeeName: employeeInfo.employeeName,
        baseSalary: baseMonthSalary,
        housingAllowance,
        welfareAllowance,
        allowances: allowances.map((a: { name: string; amount: number; description?: string }) => ({ name: a.name, amount: a.amount, description: a.description })),
        totalOT1Hours,
        totalOT2Hours,
        totalOvertimePay,
        holidayDays: actualHolidayWork.length,
        holidayDates: actualHolidayWork.map((d) => d.date),
        holidayDailySalary,
        totalHolidayPay,
        paidLeaveDays: paidLeave.length,
        paidLeavePay: 0,
        grossSalary,
        deductions: allDeductions.map((d: { name: string; amount: number; description?: string }) => ({ name: d.name, amount: d.amount })),
        totalDeductions,
        netSalary,
        attendanceData: payrollAttendanceData,
        specialLeaveInfo: specialLeaveInfo || undefined
      };

      setSalaryResult(result);
      return result;
    } catch (error) {
      console.error("Error calculating salary:", error);
      toast({
        title: "Salary calculation failed",
        description: error instanceof Error ? error.message : "Unable to calculate salary.",
        variant: "destructive"
      });
      return null;
    }
  };
  const finalizeAndSave = async (recordsToFinalize?: AttendanceRecord[]) => {
    if (!salaryResult) {
      toast({
        title: "No salary result",
        description: "Please calculate salary before saving.",
        variant: "destructive"
      });
      return false;
    }

    try {
      const sourceAttendanceData =
        recordsToFinalize && recordsToFinalize.length > 0
          ? recordsToFinalize
          : salaryResult.attendanceData;
      const payrollSourceAttendanceData = sourceAttendanceData.filter(
        (record) => !record._isSpecialLeaveCashRecord && record.id > 0
      );

      if (!payrollSourceAttendanceData || payrollSourceAttendanceData.length === 0) {
        toast({
          title: "Salary save failed",
          description: "No attendance records were found for the selected month.",
          variant: "destructive"
        });
        return false;
      }

      const employeeMap: Record<number, AttendanceRecord[]> = {};

      payrollSourceAttendanceData.forEach((record: AttendanceRecord) => {
        if (record.employeeId) {
          const employeeId = record.employeeId;
          if (!employeeMap[employeeId]) {
            employeeMap[employeeId] = [];
          }
          employeeMap[employeeId].push(record);
        }
      });

      const employeeIds = Object.keys(employeeMap).map(Number);

      if (employeeIds.length === 0) {
        toast({
          title: "Salary save failed",
          description: "No employee attendance records were found.",
          variant: "destructive"
        });
        return false;
      }

      debugLog("employeeIds", employeeIds.length);

      const finalizedRecordIds: number[] = [];

      for (const employeeId of employeeIds) {
        const employeeAttendance = employeeMap[employeeId];

        if (employeeAttendance.length === 0) continue;

        const employeeResult =
          employeeIds.length === 1 ? salaryResult : calculateSalary(employeeAttendance);

        if (employeeResult) {
          const recordToSave: SalaryResult = { ...employeeResult };
          recordToSave.employeeId = employeeId;
          recordToSave.employeeName = employeeAttendance[0]._employeeName || `Employee ID: ${employeeId}`;
          recordToSave.attendanceData = employeeAttendance;

          const specialLeaveInfo = getSpecialLeaveInfoForMonth(
            employeeId,
            recordToSave.salaryYear,
            recordToSave.salaryMonth
          );
          if (specialLeaveInfo) {
            recordToSave.specialLeaveInfo = specialLeaveInfo;
            debugLog("specialLeaveInfo", specialLeaveInfo);
          }

          debugLog("employeeSalaryRecord", {
            employeeName: recordToSave.employeeName,
            employeeId: recordToSave.employeeId
          });

          await createSalaryRecordMutation.mutateAsync(recordToSave);
          finalizedRecordIds.push(...employeeAttendance.map((record) => record.id));
        }
      }

      if (finalizedRecordIds.length > 0) {
        await deleteFilteredAttendanceMutation.mutateAsync({ ids: finalizedRecordIds });
        debugLog("attendanceCleared", finalizedRecordIds.length);
      }

      setSalaryResult(null);

      queryClient.invalidateQueries({ queryKey: ['/api/salary-records'] });

      return true;
    } catch (error) {
      console.error('Error finalizing salary:', error);
      toast({
        title: "Finalize salary failed",
        description: error instanceof Error ? error.message : "Failed to finalize salary.",
        variant: "destructive"
      });
      return false;
    }
  };

  return {
    attendanceData: sortedAttendanceData,
    isLoading,
    addAttendance,
    updateAttendance,
    deleteAttendance,
    calculateSalary,
    salaryResult,
    clearAllData,
    finalizeAndSave,
    syncStatus
  };
}
