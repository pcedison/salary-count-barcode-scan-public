import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./storage', () => ({ storage: {} }));
import { logOperation, OperationType, getOperationLogs, getAvailableLogDates } from './admin-auth';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('Cloud structured audit sink', () => {
  it('emits an event without append, free-form errors, identities or credentials', () => {
    vi.stubEnv('APP_AUDIT_SINK', 'stdout'); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const append = vi.spyOn(fs.promises, 'appendFile');
    logOperation(OperationType.LOGIN, 'secret-in-untrusted-query', { success: false, userName: 'private-name', ip: 'private-address', errorMessage: 'postgres://secret' });
    expect(append).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledOnce();
    const value = JSON.parse(output.mock.calls[0][0]);
    expect(value).toMatchObject({ component: 'attendance-audit', operation: 'login', success: false, severity: 'WARNING' });
    expect(Object.keys(value).sort()).toEqual(['component','operation','severity','success','timestamp']);
  });
  it('reports external audit storage instead of silently showing an empty history', async () => {
    vi.stubEnv('APP_AUDIT_SINK', 'stdout');
    await expect(getOperationLogs()).rejects.toMatchObject({ status: 501, code: 'AUDIT_LOGS_EXTERNAL' });
    await expect(getAvailableLogDates()).rejects.toMatchObject({ status: 501, code: 'AUDIT_LOGS_EXTERNAL' });
  });
});
