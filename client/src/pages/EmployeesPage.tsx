import { useState, type FormEvent } from 'react';

import { Plus, BadgeAlert } from 'lucide-react';

import AdminLoginDialog from '@/components/AdminLoginDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAdmin } from '@/hooks/useAdmin';
import { useToast } from '@/hooks/use-toast';
import type { Employee } from '@/types/employee';

import { EmployeeDeleteDialog } from './employees/components/EmployeeDeleteDialog';
import { EmployeeFormDialog } from './employees/components/EmployeeFormDialog';
import { EmployeeRecycleBinCard } from './employees/components/EmployeeRecycleBinCard';
import { EmployeesTableCard } from './employees/components/EmployeesTableCard';
import { LineBindingAdminPanel } from './employees/components/LineBindingAdminPanel';
import { useEmployeeManagement } from './employees/hooks/useEmployeeManagement';
import { initialEmployeeFormData, type EmployeeFormData } from './employees/types';

export default function EmployeesPage() {
  const { toast } = useToast();
  const { isAdmin, isSuperAdmin, elevatePin } = useAdmin();

  const [isFormDialogOpen, setIsFormDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isAdminDialogOpen, setIsAdminDialogOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [deletingEmployee, setDeletingEmployee] = useState<Employee | null>(null);
  const [formData, setFormData] = useState<EmployeeFormData>(initialEmployeeFormData);

  const {
    employees,
    deletedEmployees,
    isLoadingEmployees,
    createEmployeeMutation,
    updateEmployeeMutation,
    deleteEmployeeMutation,
    restoreEmployeeMutation,
    purgeEmployeeMutation,
  } = useEmployeeManagement(isAdmin);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!formData.name || !formData.idNumber) {
      toast({
        title: '資料不完整',
        description: '姓名和身分證號碼為必填項目',
        variant: 'destructive',
      });
      return;
    }

    const processedData = {
      ...formData,
      useEncryption: !!formData.useEncryption,
    };

    if (editingEmployee) {
      updateEmployeeMutation.mutate(
        { id: editingEmployee.id, data: processedData },
        {
          onSuccess: () => {
            setIsFormDialogOpen(false);
          },
        }
      );
      return;
    }

    createEmployeeMutation.mutate(processedData, {
      onSuccess: () => {
        setIsFormDialogOpen(false);
      },
    });
  };

  const handleEdit = (employee: Employee) => {
    const isIdNumberEncrypted = employee.isEncrypted || false;

    setEditingEmployee(employee);
    setFormData({
      name: employee.name,
      idNumber: employee.idNumber ?? '',
      employeeType: employee.employeeType || 'local',
      position: employee.position || '',
      department: employee.department || '',
      email: employee.email || '',
      phone: employee.phone || '',
      active: employee.active,
      useEncryption: isIdNumberEncrypted,
      isEncrypted: isIdNumberEncrypted,
    });
    setIsFormDialogOpen(true);
  };

  const handleCreateNew = () => {
    if (!isAdmin) {
      setIsAdminDialogOpen(true);
      return;
    }

    setEditingEmployee(null);
    setFormData(initialEmployeeFormData);
    setIsFormDialogOpen(true);
  };

  const handleDeleteConfirm = (employee: Employee) => {
    setDeletingEmployee(employee);
    setIsDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (!deletingEmployee) {
      return;
    }

    deleteEmployeeMutation.mutate(deletingEmployee.id, {
      onSuccess: () => {
        setIsDeleteDialogOpen(false);
        setDeletingEmployee(null);
      },
    });
  };

  const handleInputChange = <K extends keyof EmployeeFormData>(
    field: K,
    value: EmployeeFormData[K]
  ) => {
    if (field === 'useEncryption') {
      const useEncryption = value === true;
      setFormData((previous) => ({
        ...previous,
        useEncryption,
        isEncrypted: useEncryption,
      }));
      return;
    }

    setFormData((previous) => ({
      ...previous,
      [field]: value,
    }));
  };

  const handleAdminLoginSuccess = () => {
    setIsAdminDialogOpen(false);
    toast({
      title: '管理員驗證成功',
      description: '您現在可以管理員工資料',
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">員工管理</h1>
          {isAdmin && !isLoadingEmployees && (
            <p className="text-sm text-muted-foreground">目前共 {employees.length} 位員工資料可管理</p>
          )}
        </div>
        <Button onClick={handleCreateNew} className="w-full justify-center sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          新增員工
        </Button>
      </div>

      {!isAdmin && (
        <Card className="bg-amber-50 border-amber-200">
          <CardContent className="flex items-start gap-3 p-4 sm:p-6">
            <BadgeAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <p className="text-sm leading-relaxed text-amber-800 sm:text-base">
              需要管理員權限才能查看和管理員工資料
            </p>
          </CardContent>
        </Card>
      )}

      {isAdmin && isLoadingEmployees && <div className="py-12 text-center text-muted-foreground">載入中...</div>}

      {isAdmin && !isLoadingEmployees && employees.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center sm:p-10">
            <p className="text-muted-foreground">尚未添加任何員工。點擊「新增員工」按鈕開始添加。</p>
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <div className="space-y-6">
          {!isLoadingEmployees && employees.length > 0 && (
            <EmployeesTableCard employees={employees} onEdit={handleEdit} onDelete={handleDeleteConfirm} />
          )}

          <EmployeeRecycleBinCard
            employees={deletedEmployees}
            isRestoring={restoreEmployeeMutation.isPending}
            onRestore={(employeeId) => restoreEmployeeMutation.mutate(employeeId)}
            isPurging={purgeEmployeeMutation.isPending}
            onPurge={(employeeId, confirmName) => purgeEmployeeMutation.mutate({ id: employeeId, confirmName })}
            isSuperAdmin={isSuperAdmin}
            onElevateSuper={elevatePin}
          />

          <LineBindingAdminPanel />
        </div>
      )}

      <EmployeeFormDialog
        open={isFormDialogOpen}
        onOpenChange={setIsFormDialogOpen}
        editingEmployee={editingEmployee}
        formData={formData}
        isSubmitting={createEmployeeMutation.isPending || updateEmployeeMutation.isPending}
        onSubmit={handleSubmit}
        onInputChange={handleInputChange}
      />

      <EmployeeDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        employee={deletingEmployee}
        onConfirm={confirmDelete}
        isDeleting={deleteEmployeeMutation.isPending}
      />

      <AdminLoginDialog
        isOpen={isAdminDialogOpen}
        onClose={() => setIsAdminDialogOpen(false)}
        onSuccess={handleAdminLoginSuccess}
      />
    </div>
  );
}
