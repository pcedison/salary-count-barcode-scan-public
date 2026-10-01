/** A compatible rollback build must enforce this on every salary writer. */
export function arePayrollWritesPaused(): boolean {
  const value = process.env.PAYROLL_WRITES_PAUSED?.trim().toLowerCase();
  // A misspelled maintenance value must not accidentally enable writes.
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

export class PayrollWritesPausedError extends Error {
  readonly status = 503;
  readonly code = 'PAYROLL_WRITES_PAUSED';
  constructor() {
    super('薪資目前暫停寫入；請稍後重新載入，或聯絡管理員確認維護狀態。');
  }
}

export function assertPayrollWritesEnabled(): void {
  if (arePayrollWritesPaused()) throw new PayrollWritesPausedError();
}

export function assertRestoreMaintenance(): void {
  if (process.env.NODE_ENV === 'production' && !arePayrollWritesPaused()) {
    throw Object.assign(new Error('正式還原須先暫停薪資寫入並排空原有請求。'), {
      status: 409, code: 'RESTORE_REQUIRES_MAINTENANCE',
    });
  }
}
