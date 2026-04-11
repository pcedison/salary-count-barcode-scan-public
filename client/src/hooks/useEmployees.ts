import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useAdmin } from '@/hooks/useAdmin';
import type { Employee } from '../types/employee';

export type { Employee };

type UseEmployeesOptions = {
  requireAdminDetails?: boolean;
  enabled?: boolean;
};

export function useEmployees(options: UseEmployeesOptions = {}) {
  const { isAdmin } = useAdmin();
  const { requireAdminDetails = true, enabled = true } = options;
  const shouldFetchEmployees = enabled && requireAdminDetails && isAdmin;
  const queryPath = '/api/employees/admin';

  const {
    data: employees = [],
    isLoading,
    error,
    refetch
  } = useQuery<Employee[]>({
    queryKey: [queryPath],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled: shouldFetchEmployees
  });

  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.active),
    [employees]
  );

  const forceRefreshEmployees = async () => {
    if (!shouldFetchEmployees) {
      return {
        success: true as const,
        data: []
      };
    }

    const result = await refetch();

    if (result.error) {
      throw result.error;
    }

    return {
      success: true as const,
      data: result.data ?? []
    };
  };

  return {
    employees: shouldFetchEmployees ? employees : [],
    activeEmployees: shouldFetchEmployees ? activeEmployees : [],
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
    forceRefreshEmployees
  };
}
