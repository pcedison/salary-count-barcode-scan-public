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
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md p-5 sm:max-w-md sm:p-6">
        <DialogHeader className="space-y-3">
          <DialogTitle>確認刪除</DialogTitle>
          <DialogDescription>
            你確定要刪除員工 {employee?.name} 嗎？
            此操作不會立刻永久清除資料。
          </DialogDescription>
          <p className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
            刪除後會先進入回收桶 30 天；若到期未恢復，員工主檔會清除，薪資資料將匿名化保留 5 年，且恢復後需要重新綁定 LINE。
          </p>
        </DialogHeader>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            確認刪除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
