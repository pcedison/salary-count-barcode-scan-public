import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Employee } from '@/types/employee';

type EmployeeDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee | null;
  onConfirm: () => void;
  isDeleting: boolean;
};

export function EmployeeDeleteDialog({
  open,
  onOpenChange,
  employee,
  onConfirm,
  isDeleting,
}: EmployeeDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>確認刪除</DialogTitle>
          <DialogDescription>
            你確定要刪除員工 {employee?.name} 嗎？
            此操作不會立刻永久清除資料。
          </DialogDescription>
          <p className="text-sm text-muted-foreground">
            刪除後會先進入回收桶 30 天；若到期未恢復，員工主檔會清除，薪資資料將匿名化保留 5 年，且恢復後需要重新綁定 LINE。
          </p>
        </DialogHeader>

        <DialogFooter className="sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            確認刪除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
