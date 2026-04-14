import { useState, useEffect, useMemo } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/hooks/useAdmin';
import { apiRequest, getQueryFn } from '@/lib/queryClient';
import { useSettings } from '@/hooks/useSettings';
import { useEmployees } from '@/hooks/useEmployees';
import {
  createAttendanceSyncStatus,
  type AttendanceSyncStatus,
} from '@/lib/attendanceSyncStatus';
import {
  invalidateAttendanceQueries,
  normalizeAttendanceRecord,
  type AttendanceRecordLike,
} from '@/lib/attendanceRecords';
import { debugLog } from '@/lib/debug';
import { extractListData, type PaginatedPayload } from '@/lib/paginatedPayload';
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

interface AttendanceRecord {
  id: number;
  employeeId?: number;
  _employeeName?: string;
  _employeeDepartment?: string;
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
  holidayId?: number;
  holidayType?: string;
  isBarcodeScanned?: boolean;
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
    notes?: string;
  };
}

export function useAttendanceData() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAdmin();
  const { settings, holidays } = useSettings({ requireAdminSettings: isAdmin });

  const [salaryResult, setSalaryResult] = useState<SalaryResult | null>(null);
  const [syncStatus, setSyncStatus] = useState<AttendanceSyncStatus>(
    createAttendanceSyncStatus('syncing', null)
  );

  // Fetch attendance data.
  const attendanceQueryKey = isAdmin ? '/api/attendance' : '/api/attendance/today';
  const attendanceQueryFn = useMemo(
    () =>
      getQueryFn<AttendanceRecordLike[] | PaginatedPayload<AttendanceRecordLike> | null>({
        on401: isAdmin ? 'throw' : 'returnNull',
      }),
    [isAdmin]
  );

  const {
    data: rawAttendanceData,
    isLoading,
    error
  } = useQuery<AttendanceRecordLike[] | PaginatedPayload<AttendanceRecordLike> | null>({
    queryKey: [attendanceQueryKey],
    queryFn: attendanceQueryFn,
    enabled: true,
    refetchInterval: 30000,
    staleTime: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1
  });

  const isKioskLocked = !isAdmin && rawAttendanceData === null;

  const attendanceData = useMemo<AttendanceRecord[]>(() => {
    const records = rawAttendanceData ? extractListData(rawAttendanceData) : [];
    return records.map((record) => normalizeAttendanceRecord(record));
  }, [rawAttendanceData]);

  // Surface fetch errors to admins.
  useEffect(() => {
    if (isAdmin && error) {
      toast({
        title: "Attendance fetch failed",
        description: error instanceof Error ? error.message : "Failed to load attendance data",
        variant: "destructive"
      });
      console.error('Error fetching attendance data:', error);
    }
  }, [error, isAdmin, toast]);

  // Keep sync state aligned with the latest query outcome.
  useEffect(() => {
    if (isKioskLocked) {
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('locked', previous.lastSynced)
      );
      return;
    }

    if (!isLoading && !error) {
      setSyncStatus(
        createAttendanceSyncStatus('synced', new Date().toLocaleString())
      );
    } else if (error) {
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('error', previous.lastSynced)
      );
    }
  }, [attendanceData, error, isKioskLocked, isLoading]);
  // Enrich attendance rows with employee metadata.
  const { employees } = useEmployees({ requireAdminDetails: isAdmin });

  const getSpecialLeaveInfoForMonth = (employeeId: number, year: number, month: number) => {
    const employee = employees?.find(emp => emp.id === employeeId);
    if (!employee) return null;

    const usedDates = employee.specialLeaveUsedDates || [];
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

    // Normalize dates to YYYY-MM-DD.
    const normalizeDate = (date: string): string => date.replace(/\//g, '-');

    const monthlyUsedDates = usedDates
      .map(normalizeDate)
      .filter(date => date.startsWith(monthPrefix));

    const cashMonth = employee.specialLeaveCashMonth || '';
    const isCashMonth = cashMonth === `${year}年${month}月`;
    const cashDays = isCashMonth ? (employee.specialLeaveCashDays || 0) : 0;
    const baseSalary = settings?.baseMonthSalary || 29500;
    const dailySalary = Math.round(baseSalary / 30);
    const cashAmount = cashDays * dailySalary;

    if (monthlyUsedDates.length === 0 && cashDays === 0) {
      return null;
    }

    return {
      usedDays: monthlyUsedDates.length,
      usedDates: monthlyUsedDates,
      cashDays,
      cashAmount,
      notes: employee.specialLeaveNotes || ''
    };
  };

  // Enhance attendance rows with holiday labels and employee names.
  const enhancedAttendanceData = useMemo(() => {
    const attData = Array.isArray(attendanceData) ? attendanceData : [];
    debugLog('attendance enhancement counts', employees?.length || 0, 'records', attData.length);

    const holidayTypeLabels: Record<string, string> = {
      'national_holiday': '國定假日',
      'special_leave': '特別休假',
      'sick_leave': '病假',
      'personal_leave': '事假',
      'typhoon_leave': '颱風假',
      'worked': '假日出勤'
    };

    const noClockTypes = ['national_holiday', 'typhoon_leave', 'special_leave'];

    const enhancedRecords = attData.map((record: any) => {
      let enhanced: any = { ...record };

      if (record.employeeId && employees && employees.length > 0) {
        const employee = employees.find((emp) => emp.id === record.employeeId);
        if (employee) {
          enhanced._employeeName = employee.name;
          enhanced._employeeDepartment = employee.department;
        }
      }

      if (record.holidayType) {
        const isNoClockType = noClockTypes.includes(record.holidayType);
        enhanced._isLeaveRecord = true;
        enhanced._isNoClockType = isNoClockType;
        enhanced._holidayType = record.holidayType;
        enhanced._holidayName = holidayTypeLabels[record.holidayType] || '假日';
      }

      return enhanced;
    });

    return enhancedRecords;
  }, [attendanceData, employees]);

  // Sort attendance data by date
  const sortedAttendanceData = useMemo(() => {
    if (enhancedAttendanceData.length === 0) return [];

    return [...enhancedAttendanceData].sort((a, b) => {
      const dateA = new Date(a.date.replace(/\//g, '-'));
      const dateB = new Date(b.date.replace(/\//g, '-'));
      return dateA.getTime() - dateB.getTime();
    });
  }, [enhancedAttendanceData]);

  // Create attendance record
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
    mutationFn: async (salaryRecord: any) => {
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
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('syncing', previous.lastSynced)
      );
      await createAttendanceMutation.mutateAsync(record);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Update an attendance record
  const updateAttendance = async (id: number, data: Partial<NewAttendanceRecord>) => {
    try {
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('syncing', previous.lastSynced)
      );
      await updateAttendanceMutation.mutateAsync({ id, data });
      return true;
    } catch (error) {
      return false;
    }
  };

  // Delete an attendance record
  const deleteAttendance = async (id: number) => {
    try {
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('syncing', previous.lastSynced)
      );
      await deleteSingleAttendanceMutation.mutateAsync(id);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Clear all attendance records
  const clearAllData = async () => {
    try {
      setSyncStatus((previous) =>
        createAttendanceSyncStatus('syncing', previous.lastSynced)
      );
      await deleteFilteredAttendanceMutation.mutateAsync({});
      setSalaryResult(null);
      return true;
    } catch (error) {
      return false;
    }
  };

  const calculateSalary = (dataToUse?: any[]) => {
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
      const normalDays = sortedData.filter((day) => !day.isHoliday);
      const holidayDays = sortedData.filter((day) => day.isHoliday);

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

      const employeeHolidays = Array.isArray(holidays) ? holidays.filter((h: any) => !h.employeeId || h.employeeId === employeeId) : [];
      debugLog("employeeHolidays", employeeHolidays.map((h: any) => ({ date: h.date, name: h.name })));

      const actualHolidayWork = sortedData.filter((day) => {
        if (!day.clockIn || !day.clockOut || day.clockIn === "" || day.clockOut === "" || day.clockIn === "--:--" || day.clockOut === "--:--") {
          return false;
        }

        const holidayRecord = employeeHolidays.find((h: any) => h.date === day.date);
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

      const paidLeave = employeeHolidays.filter((h: any) => {
        const hasAttendanceRecord = sortedData.some((day) =>
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

      sortedData.forEach((day) => {
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
      const grossSalary = calculateGrossSalary(baseMonthSalary, totalOvertimePay, totalHolidayPay, welfareAllowance, housingAllowance);
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
        attendanceData: sortedData
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
  const finalizeAndSave = async () => {
    if (!salaryResult) {
      toast({
        title: "No salary result",
        description: "Please calculate salary before saving.",
        variant: "destructive"
      });
      return false;
    }

    try {
      const allAttendanceData = attendanceData as AttendanceRecord[];

      const isSingleEmployeeMode = salaryResult.attendanceData &&
                                 salaryResult.attendanceData.length > 0 &&
                                 salaryResult.attendanceData.every(record =>
                                   record.employeeId === salaryResult.attendanceData[0].employeeId);

      if (isSingleEmployeeMode) {
        const singleRecord: any = { ...salaryResult };

        if (singleRecord.attendanceData && singleRecord.attendanceData.length > 0) {
          const employeeData = singleRecord.attendanceData[0];
          singleRecord.employeeId = employeeData.employeeId;
          singleRecord.employeeName = employeeData._employeeName || `Employee ID: ${employeeData.employeeId}`;

          const specialLeaveInfo = getSpecialLeaveInfoForMonth(
            employeeData.employeeId,
            singleRecord.salaryYear,
            singleRecord.salaryMonth
          );
          if (specialLeaveInfo) {
            singleRecord.specialLeaveInfo = specialLeaveInfo;
            debugLog("specialLeaveInfo", specialLeaveInfo);
          }

          debugLog("singleEmployeeSalary", {
            employeeName: singleRecord.employeeName,
            employeeId: singleRecord.employeeId
          });
          await createSalaryRecordMutation.mutateAsync(singleRecord);

          if (singleRecord.employeeId) {
            await deleteFilteredAttendanceMutation.mutateAsync({ employeeId: singleRecord.employeeId });
            debugLog("deletedAttendanceForEmployee", {
              employeeName: singleRecord.employeeName,
              employeeId: singleRecord.employeeId
            });
          }
        } else {
          await createSalaryRecordMutation.mutateAsync(singleRecord);
        }
      }
      else {
        const employeeMap: Record<number, any[]> = {};

        allAttendanceData.forEach((record: AttendanceRecord) => {
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

        for (const employeeId of employeeIds) {
          const employeeAttendance = employeeMap[employeeId];

          if (employeeAttendance.length === 0) continue;

          const employeeResult = calculateSalary(employeeAttendance);

          if (employeeResult) {
            const recordToSave: any = { ...employeeResult };
            recordToSave.employeeId = employeeId;
            recordToSave.employeeName = employeeAttendance[0]._employeeName || `Employee ID: ${employeeId}`;

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
          }
        }

        await deleteFilteredAttendanceMutation.mutateAsync({});
        debugLog("attendanceCleared");
      }

      try {
        const response = await apiRequest('DELETE', '/api/holidays');
        if (response.ok) {
          debugLog('holiday cache cleared after salary finalization');
          queryClient.invalidateQueries({ queryKey: ['/api/holidays'] });
        }
      } catch (error) {
        console.error('Failed to clear holidays after salary finalization:', error);
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
