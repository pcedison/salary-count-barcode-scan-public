/** This compatible build is read-only for payroll in production. */
export function arePayrollWritesPaused(): boolean {
  // Direct CLI imports must fail closed even if they bypass app bootstrap.
  if (process.env.NODE_ENV === 'production') {
    assertMaintenanceStartup();
    return true;
  }
  const value = process.env.PAYROLL_WRITES_PAUSED?.trim().toLowerCase();
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

export function assertMaintenanceStartup(): void {
  if (process.env.NODE_ENV === 'production' && process.env.PAYROLL_WRITES_PAUSED !== 'true') {
    throw new Error('Maintenance build requires PAYROLL_WRITES_PAUSED=true in production.');
  }
}

export class PayrollWritesPausedError extends Error {
  readonly status = 503;
  readonly code = 'PAYROLL_WRITES_PAUSED';
  constructor() {
    super('薪資目前暫停寫入；請聯絡管理員確認維護狀態。');
  }
}

export function assertPayrollWritesEnabled(): void {
  if (arePayrollWritesPaused()) throw new PayrollWritesPausedError();
}

/** Legacy JSON backups cannot preserve journals unknown to this schema. */
export function assertLegacyBackupWritesEnabled(): void {
  if (arePayrollWritesPaused()) {
    throw Object.assign(new Error('維護版本停用 JSON 備份寫入與還原；請使用經確認的完整 PostgreSQL 備份。'), {
      status: 503, code: 'MAINTENANCE_BACKUP_READ_ONLY',
    });
  }
}
