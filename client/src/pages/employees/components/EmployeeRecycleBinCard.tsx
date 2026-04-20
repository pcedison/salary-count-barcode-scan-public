import { useState } from 'react';
import { RotateCcw, Trash2, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import type { DeletedEmployee } from '../types';

type PurgeDialogStep = 'elevate' | 'confirm';

type EmployeeRecycleBinCardProps = {
  employees: DeletedEmployee[];
  isRestoring: boolean;
  onRestore: (employeeId: number) => void;
  isPurging: boolean;
  onPurge: (employeeId: number, confirmName: string) => void;
  isSuperAdmin: boolean;
  onElevateSuper: (pin: string) => Promise<boolean>;
};

export function EmployeeRecycleBinCard({
  employees,
  isRestoring,
  onRestore,
  isPurging,
  onPurge,
  isSuperAdmin,
  onElevateSuper,
}: EmployeeRecycleBinCardProps) {
  const [purgeTarget, setPurgeTarget] = useState<DeletedEmployee | null>(null);
  const [step, setStep] = useState<PurgeDialogStep>('elevate');
  const [superPin, setSuperPin] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  const [isElevating, setIsElevating] = useState(false);
  const [elevateError, setElevateError] = useState('');

  const openPurgeDialog = (employee: DeletedEmployee) => {
    setPurgeTarget(employee);
    // If already SUPER, skip elevation step
    setStep(isSuperAdmin ? 'confirm' : 'elevate');
    setSuperPin('');
    setConfirmInput('');
    setElevateError('');
  };

  const closePurgeDialog = () => {
    setPurgeTarget(null);
    setSuperPin('');
    setConfirmInput('');
    setElevateError('');
  };

  const handleElevate = async () => {
    if (!superPin) return;
    setIsElevating(true);
    setElevateError('');
    try {
      const ok = await onElevateSuper(superPin);
      if (ok) {
        setStep('confirm');
        setSuperPin('');
      } else {
        setElevateError('Super 管理員 PIN 不正確，請重試');
      }
    } finally {
      setIsElevating(false);
    }
  };

  const handleConfirmPurge = () => {
    if (!purgeTarget || confirmInput !== purgeTarget.name) return;
    onPurge(purgeTarget.id, confirmInput);
    closePurgeDialog();
  };

  const isActionPending = isRestoring || isPurging;

  if (employees.length === 0) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-3 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trash2 className="h-4 w-4 text-amber-600" />
                員工回收桶
              </CardTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                刪除後會先進入回收桶 30 天。若超過保留期仍未恢復，員工主檔會清除，薪資資料將匿名化保留 5 年供查核使用；恢復後 LINE 需重新綁定。
              </p>
            </div>
            <span className="inline-flex w-fit items-center rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
              {employees.length} 筆待處理
            </span>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
          <div className="space-y-3 md:hidden">
            {employees.map((employee) => (
              <div key={employee.id} className="rounded-lg border bg-background p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-base font-semibold">{employee.name}</p>
                    <p className="break-all font-mono text-sm text-muted-foreground">{employee.idNumber || '-'}</p>
                  </div>
                  <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                    回收桶
                  </span>
                </div>

                <dl className="mt-4 space-y-3 text-sm">
                  <div className="space-y-1">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">刪除時間</dt>
                    <dd>{employee.deletedAt ? new Date(employee.deletedAt).toLocaleString('zh-TW') : '-'}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">自動清除</dt>
                    <dd>{employee.purgeAfterAt ? new Date(employee.purgeAfterAt).toLocaleDateString('zh-TW') : '-'}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">保留規則</dt>
                    <dd className="leading-relaxed text-muted-foreground">
                      {employee.salaryRetentionMode === 'anonymized'
                        ? `匿名化保留 ${employee.salaryRetentionYears ?? 5} 年`
                        : '依系統保留規則處理'}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => onRestore(employee.id)}
                    disabled={isActionPending}
                  >
                    <RotateCcw className="h-4 w-4" />
                    恢復
                  </Button>
                  <Button
                    variant="destructive"
                    className="w-full"
                    onClick={() => openPurgeDialog(employee)}
                    disabled={isActionPending}
                  >
                    <Trash2 className="h-4 w-4" />
                    永久刪除
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:block">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>員工</TableHead>
                  <TableHead>證號</TableHead>
                  <TableHead>刪除時間</TableHead>
                  <TableHead>自動清除</TableHead>
                  <TableHead>保留規則</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell className="font-medium">{employee.name}</TableCell>
                    <TableCell className="font-mono">{employee.idNumber}</TableCell>
                    <TableCell>
                      {employee.deletedAt ? new Date(employee.deletedAt).toLocaleString('zh-TW') : '-'}
                    </TableCell>
                    <TableCell>
                      {employee.purgeAfterAt ? new Date(employee.purgeAfterAt).toLocaleDateString('zh-TW') : '-'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {employee.salaryRetentionMode === 'anonymized'
                        ? `匿名化保留 ${employee.salaryRetentionYears ?? 5} 年`
                        : '依系統保留規則處理'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => onRestore(employee.id)}
                          disabled={isActionPending}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          恢復
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="gap-1"
                          onClick={() => openPurgeDialog(employee)}
                          disabled={isActionPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          永久刪除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Step 1: SUPER PIN elevation (skipped if already super) */}
      <Dialog
        open={purgeTarget !== null && step === 'elevate'}
        onOpenChange={(open) => {
          if (!open) closePurgeDialog();
        }}
      >
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto p-5 sm:max-w-md sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
              需要 Super 管理員驗證
            </DialogTitle>
            <DialogDescription>
              永久刪除員工為高風險操作，需要先輸入 Super 管理員 PIN 碼。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="super-pin">Super 管理員 PIN</Label>
              <Input
                id="super-pin"
                type="password"
                value={superPin}
                onChange={(e) => {
                  setSuperPin(e.target.value);
                  setElevateError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleElevate();
                }}
                placeholder="請輸入 6 位數字"
                autoComplete="off"
                maxLength={6}
              />
            </div>
            {elevateError && <p className="text-xs text-destructive">{elevateError}</p>}
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={closePurgeDialog}
              disabled={isElevating}
            >
              取消
            </Button>
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={() => void handleElevate()}
              disabled={isElevating || superPin.length === 0}
            >
              {isElevating ? '驗證中…' : '驗證'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step 2: Name confirmation */}
      <Dialog
        open={purgeTarget !== null && step === 'confirm'}
        onOpenChange={(open) => {
          if (!open) closePurgeDialog();
        }}
      >
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto p-5 sm:max-w-md sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-destructive">永久刪除員工</DialogTitle>
            <DialogDescription>
              此操作<strong>無法復原</strong>。員工主檔將完全清除，薪資紀錄將匿名化保留供查核。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              請輸入員工姓名 <span className="font-semibold text-foreground">「{purgeTarget?.name}」</span> 以確認永久刪除：
            </p>
            <div className="space-y-1">
              <Label htmlFor="confirm-name">員工姓名確認</Label>
              <Input
                id="confirm-name"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmPurge();
                }}
                placeholder={purgeTarget?.name ?? ''}
                autoComplete="off"
              />
            </div>
            {confirmInput.length > 0 && confirmInput !== purgeTarget?.name && (
              <p className="text-xs text-destructive">姓名不符，請重新輸入</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={closePurgeDialog}
              disabled={isPurging}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={handleConfirmPurge}
              disabled={isPurging || confirmInput !== purgeTarget?.name}
            >
              {isPurging ? '刪除中…' : '確認永久刪除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
