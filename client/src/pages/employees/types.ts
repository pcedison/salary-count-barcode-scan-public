import type { Employee } from '@/types/employee';

export type DeletedEmployee = Employee & {
  recycleRetentionDays?: number;
  salaryRetentionMode?: 'anonymized';
  salaryRetentionYears?: number;
  lineRestoreMode?: 'rebind_required';
  requiresLineRebind?: boolean;
  deletedAt?: string | null;
  deletedBy?: string | null;
  purgeAfterAt?: string | null;
};

export interface PendingBinding {
  id: number;
  employeeId: number;
  employeeName: string;
  lineUserId: string;
  lineDisplayName?: string;
  linePictureUrl?: string;
  status: string;
  requestedAt?: string;
}

export interface EmployeeFormData {
  name: string;
  idNumber: string;
  employeeType: 'local' | 'foreign';
  position: string;
  department: string;
  email: string;
  phone: string;
  active: boolean;
  useEncryption?: boolean;
  isEncrypted?: boolean;
}

export const initialEmployeeFormData: EmployeeFormData = {
  name: '',
  idNumber: '',
  employeeType: 'local',
  position: '',
  department: '',
  email: '',
  phone: '',
  active: true,
  useEncryption: false,
  isEncrypted: false,
};
