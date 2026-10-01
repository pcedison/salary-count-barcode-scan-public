import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/hooks/useAdmin';
import { useToast } from '@/hooks/use-toast';
import { extractListData, type PaginatedPayload } from '@/lib/paginatedPayload';
import { apiRequest } from '@/lib/queryClient';
import { buildSalaryRecordCsv, salaryRecordFileName, type ExportSalaryRecord } from '@/lib/historyExport';
import { buildSalaryHistoryQuery, type SalaryHistoryFilters } from '@/lib/historyQuery';

export interface SalaryRecord extends ExportSalaryRecord {
  revision: number;
  totalOT1Hours: number;
  totalOT2Hours: number;
  totalOvertimePay: number;
  holidayDays: number;
  totalHolidayPay: number;
  totalDeductions: number;
  deductions: Array<{ name: string; amount: number }>;
  attendanceData: Array<{ date: string; clockIn: string; clockOut: string; isHoliday: boolean; holidayType?: string; employeeId?: number }> | null;
}

export function useHistoryData(filters: SalaryHistoryFilters = { page: 1, limit: 10 }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAdmin();
  const { data: payload, isLoading, isFetching, error, refetch } = useQuery<PaginatedPayload<SalaryRecord>>({
    queryKey: ['/api/salary-records', filters],
    queryFn: async () => (await apiRequest('GET', buildSalaryHistoryQuery(filters))).json(),
    enabled: isAdmin,
    staleTime: 30_000,
  });
  const salaryRecords = extractListData(payload);
  const pagination = payload?.pagination ?? { page: filters.page, limit: filters.limit, total: salaryRecords.length, pages: salaryRecords.length ? 1 : 0 };
  const refreshSalaryQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['/api/salary-records'] });
    void queryClient.invalidateQueries({ queryKey: ['/api/salary-records/finalized-months'] });
  }, [queryClient]);

  const deleteSalaryRecordMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/salary-records/${id}`);
      return id;
    },
    onSuccess: refreshSalaryQueries,
  });
  const updateSalaryRecordMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const response = await apiRequest('PATCH', `/api/salary-records/${id}`, data);
      return response.json();
    },
    onSuccess: refreshSalaryQueries,
  });
  const deleteSalaryRecord = useCallback(async (id: number) => deleteSalaryRecordMutation.mutateAsync(id), [deleteSalaryRecordMutation]);
  const updateSalaryRecord = useCallback(async (id: number, data: Record<string, unknown>) => updateSalaryRecordMutation.mutateAsync({ id, data }), [updateSalaryRecordMutation]);
  const getSalaryRecordById = useCallback(async (id: number): Promise<SalaryRecord> => {
    if (!isAdmin) throw new Error('Admin privileges are required to read salary records.');
    return (await apiRequest('GET', `/api/salary-records/${id}`)).json();
  }, [isAdmin]);
  const exportSalaryRecordAsCsv = useCallback(async (record: Pick<SalaryRecord, 'id'>) => {
    try {
      // Fetch the committed revision so a stale table row cannot export pre-correction values.
      const freshRecord = await getSalaryRecordById(record.id);
      const blob = new Blob([buildSalaryRecordCsv(freshRecord)], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = salaryRecordFileName(freshRecord);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
      toast({ title: '匯出成功', description: '已匯出最新確認的薪資結算快照。' });
    } catch {
      toast({ title: '匯出失敗', description: '無法讀取最新薪資紀錄，請稍後重試。', variant: 'destructive' });
    }
  }, [getSalaryRecordById, toast]);

  return {
    salaryRecords, pagination, isLoading, isFetching, error, refetch, refreshSalaryQueries,
    getSalaryRecordById, exportSalaryRecordAsCsv, deleteSalaryRecord, updateSalaryRecord,
    isDeletingRecord: deleteSalaryRecordMutation.isPending,
    isUpdatingRecord: updateSalaryRecordMutation.isPending,
  };
}
