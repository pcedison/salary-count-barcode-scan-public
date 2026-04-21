import { Copy, Lock, Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import type { Employee } from '@/types/employee';

type EmployeesTableCardProps = {
  employees: Employee[];
  onEdit: (employee: Employee) => void;
  onDelete: (employee: Employee) => void;
};

export function EmployeesTableCard({
  employees,
  onEdit,
  onDelete,
}: EmployeesTableCardProps) {
  const { toast } = useToast();

  const handleCopyScanId = (employee: Employee) => {
    const scanIdNumber = employee.scanIdNumber || employee.idNumber || '';

    navigator.clipboard.writeText(scanIdNumber);
    toast({
      title: '已複製掃碼 ID',
      description: '掃碼專用 ID 已複製到剪貼簿，可直接用於條碼掃描。',
    });
  };

  return (
    <Card>
      <CardHeader className="gap-3 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">員工列表</CardTitle>
            <CardDescription>桌面維持表格效率，手機可直接用卡片管理與操作員工資料。</CardDescription>
          </div>
          <span className="inline-flex w-fit items-center rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground">
            共 {employees.length} 位
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
        <div className="space-y-3 md:hidden">
          {employees.map((employee) => (
            <div key={employee.id} className="rounded-lg border bg-background p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold">{employee.name}</p>
                    {employee.employeeType === 'foreign' && (
                      <span
                        title="外籍員工（護照號碼）"
                        className="inline-flex items-center rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700"
                      >
                        外
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <span>{employee.department || '未設定部門'}</span>
                    <span>{employee.position || '未設定職位'}</span>
                  </div>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-xs ${
                    employee.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}
                >
                  {employee.active ? '在職中' : '離職'}
                </span>
              </div>

              <div className="mt-4 space-y-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {employee.employeeType === 'foreign' ? '護照號碼' : '身分證號碼'}
                  </p>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p
                        title={employee.isEncrypted ? '系統以 AES 加密形式儲存' : ''}
                        className="break-all font-mono text-sm"
                      >
                        {employee.idNumber || '-'}
                      </p>
                      {employee.isEncrypted && (
                        <span
                          title="資料庫內為 AES 加密儲存"
                          className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700"
                        >
                          <Lock className="h-3 w-3" />
                          已加密儲存
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      title="複製掃碼專用 ID"
                      onClick={() => handleCopyScanId(employee)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      複製掃碼 ID
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" className="w-full" onClick={() => onEdit(employee)}>
                    <Pencil className="h-4 w-4" />
                    編輯
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => onDelete(employee)}
                  >
                    <Trash2 className="h-4 w-4" />
                    刪除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="hidden md:block">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>證件號碼</TableHead>
                <TableHead>部門</TableHead>
                <TableHead>職位</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1.5">
                      {employee.name}
                      {employee.employeeType === 'foreign' && (
                        <span
                          title="外籍員工（護照號碼）"
                          className="inline-flex items-center rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700"
                        >
                          外
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono">
                    <div className="flex items-center">
                      <span
                        title={employee.isEncrypted ? '系統以 AES 加密形式儲存' : ''}
                        className="mr-1 max-w-[120px] truncate"
                      >
                        {employee.idNumber}
                      </span>
                      <span className="mr-1 text-xs text-muted-foreground">
                        {employee.employeeType === 'foreign' ? '(護照)' : '(身分證)'}
                      </span>

                      {employee.isEncrypted && (
                        <span
                          title="資料庫內為 AES 加密儲存"
                          className="rounded-full bg-amber-50 p-1 text-amber-600"
                        >
                          <Lock className="h-3 w-3" />
                        </span>
                      )}

                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-1 h-6 w-6"
                        title="複製掃碼專用 ID"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCopyScanId(employee);
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>{employee.department || '-'}</TableCell>
                  <TableCell>{employee.position || '-'}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-xs ${
                        employee.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {employee.active ? '在職中' : '離職'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => onEdit(employee)} title="編輯">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onDelete(employee)}
                      title="刪除"
                      className="text-red-500 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
