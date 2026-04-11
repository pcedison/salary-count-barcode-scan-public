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

  if (employees.length === 0) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trash2 className="h-4 w-4 text-amber-600" />
            員工回收桶
          </CardTitle>
          <p className="text-sm text-muted-foreground leading-relaxed">
            刪除後會先進入回收桶 30 天。若超過保留期仍未恢復，員工主檔會清除，薪資資料將匿名化保留 5 年供查核使用；恢復後 LINE 需重新綁定。
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
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
                        disabled={isRestoring || isPurging}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        恢復
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="gap-1"
                        onClick={() => openPurgeDialog(employee)}
                        disabled={isRestoring || isPurging}
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
        </CardContent>
      </Card>

      {/* Step 1: SUPER PIN elevation (skipped if already super) */}
      <Dialog open={purgeTarget !== null && step === 'elevate'} onOpenChange={(open) => { if (!open) closePurgeDialog(); }}>
        <DialogContent className="sm:max-w-md">
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
                onChange={(e) => { setSuperPin(e.target.value); setElevateError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleElevate(); }}
                placeholder="請輸入 6 位數字"
                autoComplete="off"
                maxLength={6}
              />
            </div>
            {elevateError && (
              <p className="text-xs text-destructive">{elevateError}</p>
            )}
          </div>

          <DialogFooter className="sm:justify-end">
            <Button type="button" variant="outline" onClick={closePurgeDialog} disabled={isElevating}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleElevate()}
              disabled={isElevating || superPin.length === 0}
            >
              {isElevating ? '驗證中…' : '驗證'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step 2: Name confirmation */}
      <Dialog open={purgeTarget !== null && step === 'confirm'} onOpenChange={(open) => { if (!open) closePurgeDialog(); }}>
        <DialogContent className="sm:max-w-md">
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
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmPurge(); }}
                placeholder={purgeTarget?.name ?? ''}
                autoComplete="off"
              />
            </div>
            {confirmInput.length > 0 && confirmInput !== purgeTarget?.name && (
              <p className="text-xs text-destructive">姓名不符，請重新輸入</p>
            )}
          </div>

          <DialogFooter className="sm:justify-end">
            <Button type="button" variant="outline" onClick={closePurgeDialog} disabled={isPurging}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
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
