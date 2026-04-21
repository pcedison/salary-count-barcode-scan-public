import type { FormEvent } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
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
import { Button } from '@/components/ui/button';
import { Lock } from 'lucide-react';

import type { Employee } from '@/types/employee';

import type { EmployeeFormData } from '../types';

type EmployeeFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingEmployee: Employee | null;
  formData: EmployeeFormData;
  isSubmitting: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onInputChange: <K extends keyof EmployeeFormData>(field: K, value: EmployeeFormData[K]) => void;
};

export function EmployeeFormDialog({
  open,
  onOpenChange,
  editingEmployee,
  formData,
  isSubmitting,
  onSubmit,
  onInputChange,
}: EmployeeFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto p-5 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>{editingEmployee ? '編輯員工' : '新增員工'}</DialogTitle>
          <DialogDescription>
            {editingEmployee ? '更新員工資料並保存' : '輸入新員工的資料'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="name">姓名 *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(event) => onInputChange('name', event.target.value)}
              placeholder="例如：王小明"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>員工類型</Label>
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="employeeType"
                  value="local"
                  checked={formData.employeeType === 'local'}
                  onChange={() => onInputChange('employeeType', 'local')}
                  className="accent-primary"
                />
                <span className="text-sm">本地員工（身分證）</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="employeeType"
                  value="foreign"
                  checked={formData.employeeType === 'foreign'}
                  onChange={() => onInputChange('employeeType', 'foreign')}
                  className="accent-primary"
                />
                <span className="flex items-center gap-1 text-sm">
                  外籍員工（護照號碼）
                  <span className="inline-flex items-center rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">
                    外
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="idNumber">
              {formData.employeeType === 'foreign' ? '護照號碼' : '身分證號碼'} *
            </Label>
            <Input
              id="idNumber"
              value={formData.idNumber}
              onChange={(event) => onInputChange('idNumber', event.target.value)}
              placeholder={formData.employeeType === 'foreign' ? '例如：E01839502' : '例如：A123456789'}
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="department">部門</Label>
              <Input
                id="department"
                value={formData.department}
                onChange={(event) => onInputChange('department', event.target.value)}
                placeholder="例如：行政部"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="position">職位</Label>
              <Input
                id="position"
                value={formData.position}
                onChange={(event) => onInputChange('position', event.target.value)}
                placeholder="例如：專員"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="email">電子郵件</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(event) => onInputChange('email', event.target.value)}
                placeholder="例如：employee@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">電話</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(event) => onInputChange('phone', event.target.value)}
                placeholder="例如：0912345678"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-start space-x-3 rounded-lg border p-3">
              <Checkbox
                id="active"
                className="mt-0.5"
                checked={formData.active}
                onCheckedChange={(checked) => onInputChange('active', checked === true)}
              />
              <Label htmlFor="active" className="cursor-pointer leading-relaxed">
                員工目前在職中
              </Label>
            </div>

            <div className="flex items-start space-x-3 rounded-lg border p-3">
              <Checkbox
                id="useEncryption"
                className="mt-0.5"
                checked={formData.useEncryption}
                onCheckedChange={(checked) => onInputChange('useEncryption', checked === true)}
              />
              <Label htmlFor="useEncryption" className="cursor-pointer leading-relaxed">
                <span className="flex items-center gap-1">
                  <Lock className="h-4 w-4 text-amber-600" />
                  使用加密保護身分證號碼 (用於條碼掃描)
                </span>
              </Label>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={isSubmitting}>
              {editingEmployee ? '更新' : '新增'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
