import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { debugLog } from '@/lib/debug';
import type { Employee } from '@/types/employee';

import type { DeletedEmployee, EmployeeFormData } from '../types';

const EMPLOYEES_QUERY_KEY = ['/api/employees/admin'] as const;
const DELETED_EMPLOYEES_QUERY_KEY = ['/api/employees/deleted'] as const;
const PUBLIC_EMPLOYEES_QUERY_KEY = ['/api/employees'] as const;

function invalidateEmployeeQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: PUBLIC_EMPLOYEES_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: DELETED_EMPLOYEES_QUERY_KEY });
}

export function useEmployeeManagement(enabled: boolean) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const employeesQuery = useQuery<Employee[]>({
    queryKey: EMPLOYEES_QUERY_KEY,
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/employees/admin');
      return response.json();
    },
    enabled,
  });

  const deletedEmployeesQuery = useQuery<DeletedEmployee[]>({
    queryKey: DELETED_EMPLOYEES_QUERY_KEY,
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/employees/deleted');
      return response.json();
    },
    enabled,
  });

  const createEmployeeMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) => {
      const response = await apiRequest('POST', '/api/employees', data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PUBLIC_EMPLOYEES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
      toast({
        title: '成功新增',
        description: '員工已成功新增',
      });
    },
    onError: (error: Error) => {
      toast({
        title: '新增失敗',
        description: error.message || '無法新增員工，請重試',
        variant: 'destructive',
      });
    },
  });

  const updateEmployeeMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: EmployeeFormData }) => {
      debugLog('提交更新資料:', JSON.stringify(data));
      const response = await apiRequest('PUT', `/api/employees/${id}`, data);
      const result = await response.json();
      debugLog('更新結果:', JSON.stringify(result));
      return result as Employee;
    },
    onSuccess: (updatedEmployee) => {
      queryClient.setQueryData<Employee[]>(EMPLOYEES_QUERY_KEY, (oldData) => {
        if (!oldData) {
          return oldData;
        }

        return oldData.map((employee) =>
          employee.id === updatedEmployee.id ? updatedEmployee : employee
        );
      });

      queryClient.invalidateQueries({ queryKey: PUBLIC_EMPLOYEES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
      toast({
        title: '成功更新',
        description: '員工資料已成功更新',
      });
    },
    onError: (error: Error) => {
      toast({
        title: '更新失敗',
        description: error.message || '無法更新員工資料，請重試',
        variant: 'destructive',
      });
    },
  });

  const deleteEmployeeMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest('DELETE', `/api/employees/${id}`);
      return response.status === 204 ? null : response.json();
    },
    onSuccess: () => {
      invalidateEmployeeQueries(queryClient);
      toast({
        title: '已移入回收桶',
        description: '員工資料會先保留 30 天，若逾期未恢復，薪資資料將匿名化保留 5 年。',
      });
    },
    onError: (error: Error) => {
      toast({
        title: '刪除失敗',
        description: error.message || '無法刪除員工，請重試',
        variant: 'destructive',
      });
    },
  });

  const restoreEmployeeMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest('POST', `/api/employees/${id}/restore`);
      return response.json();
    },
    onSuccess: () => {
      invalidateEmployeeQueries(queryClient);
      toast({
        title: '員工已恢復',
        description: '員工資料已回到現行名單，但需要重新綁定 LINE 才能使用 LINE 打卡。',
      });
    },
    onError: (error: Error) => {
      toast({
        title: '恢復失敗',
        description: error.message || '無法恢復回收桶中的員工資料，請稍後再試。',
        variant: 'destructive',
      });
    },
  });

  const purgeEmployeeMutation = useMutation({
    mutationFn: async ({ id, confirmName }: { id: number; confirmName: string }) => {
      const response = await apiRequest('DELETE', `/api/employees/${id}/purge`, { confirmName });
      return response.json();
    },
    onSuccess: (data: { anonymizedSalaryRecords: number }) => {
      invalidateEmployeeQueries(queryClient);
      toast({
        title: '已永久刪除',
        description: `員工資料已清除，${data.anonymizedSalaryRecords} 筆薪資紀錄已匿名化保留。`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: '永久刪除失敗',
        description: error.message || '無法永久刪除員工，請稍後再試。',
        variant: 'destructive',
      });
    },
  });

  return {
    employees: employeesQuery.data ?? [],
    deletedEmployees: deletedEmployeesQuery.data ?? [],
    isLoadingEmployees: employeesQuery.isLoading,
    createEmployeeMutation,
    updateEmployeeMutation,
    deleteEmployeeMutation,
    restoreEmployeeMutation,
    purgeEmployeeMutation,
  };
}
