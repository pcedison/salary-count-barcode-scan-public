import { Copy, Lock, Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
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
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700"
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
                      className="truncate mr-1 max-w-[120px]"
                    >
                      {employee.idNumber}
                    </span>
                    <span className="text-xs text-muted-foreground mr-1">
                      {employee.employeeType === 'foreign' ? '(護照)' : '(身分證)'}
                    </span>

                    {employee.isEncrypted && (
                      <span
                        title="資料庫內為 AES 加密儲存"
                        className="text-amber-600 bg-amber-50 rounded-full p-1"
                      >
                        <Lock className="h-3 w-3" />
                      </span>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 ml-1"
                      title="複製掃碼專用 ID"
                      onClick={(event) => {
                        event.stopPropagation();
                        const scanIdNumber = employee.scanIdNumber || employee.idNumber || '';

                        navigator.clipboard.writeText(scanIdNumber);
                        toast({
                          title: '已複製掃碼 ID',
                          description: '掃碼專用 ID 已複製到剪貼簿，可直接用於條碼掃描。',
                        });
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
                    className={`inline-flex items-center px-2 py-1 rounded-full text-xs ${
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
                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
