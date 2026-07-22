import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useToast } from '@/hooks/use-toast';
import { apiRequest, getQueryFn } from '@/lib/queryClient';
import {
  createAttendanceSyncStatus,
  type AttendanceSyncStatus,
} from '@/lib/attendanceSyncStatus';
import {
  normalizeAttendanceRecord,
  type AttendanceRecordLike,
} from '@/lib/attendanceRecords';
import { extractListData, type PaginatedPayload } from '@/lib/paginatedPayload';
import {
  buildFinalizedSalaryMonthKeys,
  buildSpecialLeaveCashRecords,
  enhanceAttendanceRecords,
  filterFinalizedAttendance,
  sortAttendanceNewestFirst,
  type AttendanceRecord,
  type EmployeeLike,
  type FinalizedSalaryRecordLike,
} from '@/lib/attendanceEnhancement';

const ATTENDANCE_PAGE_LIMIT = 1000;

async function fetchAttendanceJson(path: string) {
  const response = await apiRequest('GET', path);
  return response.json();
}

async function fetchAllAttendancePages(): Promise<PaginatedPayload<AttendanceRecordLike>> {
  const records: AttendanceRecordLike[] = [];
  let page = 1;
  let total = 0;
  let pages = 1;

  do {
    const payload = (await fetchAttendanceJson(
      `/api/attendance?page=${page}&limit=${ATTENDANCE_PAGE_LIMIT}`
    )) as AttendanceRecordLike[] | PaginatedPayload<AttendanceRecordLike>;
    const pageRecords = extractListData(payload);
    records.push(...pageRecords);

    if (!Array.isArray(payload) && payload.pagination) {
      total = payload.pagination.total;
      pages = payload.pagination.pages;
    } else {
      total = records.length;
      pages = 1;
    }

    page += 1;
  } while (page <= pages);

  return {
    data: records,
    pagination: {
      page: 1,
      limit: records.length || ATTENDANCE_PAGE_LIMIT,
      total,
      pages: records.length > 0 ? 1 : 0
    }
  };
}

export interface UseAttendanceQueriesParams {
  isAdmin: boolean;
  employees: EmployeeLike[] | undefined;
  baseMonthSalary: number;
}

/**
 * useAttendanceData 的查詢軸:出勤/薪資紀錄抓取、同步狀態、
 * 已結算月份過濾與顯示增強(純邏輯在 lib/attendanceEnhancement)。
 */
export function useAttendanceQueries({ isAdmin, employees, baseMonthSalary }: UseAttendanceQueriesParams) {
  const { toast } = useToast();
  const [syncStatus, setSyncStatus] = useState<AttendanceSyncStatus>(
    createAttendanceSyncStatus('syncing', null)
  );

  const attendanceQueryKey = isAdmin ? '/api/attendance?allPages=true' : '/api/attendance/today';
  const attendanceQueryFn = useMemo(
    () =>
      isAdmin
        ? async () => fetchAllAttendancePages()
        : getQueryFn<AttendanceRecordLike[] | PaginatedPayload<AttendanceRecordLike> | null>({
            on401: 'returnNull',
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

  const { data: rawSalaryRecords = [] } = useQuery<
    FinalizedSalaryRecordLike[] | PaginatedPayload<FinalizedSalaryRecordLike>
  >({
    queryKey: ['/api/salary-records'],
    enabled: isAdmin,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1
  });

  const finalizedSalaryMonthKeys = useMemo(
    () => buildFinalizedSalaryMonthKeys(extractListData(rawSalaryRecords)),
    [rawSalaryRecords]
  );

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

  // Enhance attendance rows with employee metadata, holiday labels, and
  // synthetic special-leave-cash rows; newest records first.
  const sortedAttendanceData = useMemo(() => {
    const active = filterFinalizedAttendance(attendanceData, finalizedSalaryMonthKeys);
    const enhanced = enhanceAttendanceRecords(active, employees);
    const cashRecords = buildSpecialLeaveCashRecords(employees, finalizedSalaryMonthKeys, baseMonthSalary);
    return sortAttendanceNewestFirst([...enhanced, ...cashRecords]);
  }, [attendanceData, employees, finalizedSalaryMonthKeys, baseMonthSalary]);

  return {
    attendanceData,
    sortedAttendanceData,
    isLoading,
    syncStatus,
    /** mutations 開始時標記為同步中(保留原 UI 行為)。 */
    markSyncing: () =>
      setSyncStatus((previous) => createAttendanceSyncStatus('syncing', previous.lastSynced)),
  };
}
