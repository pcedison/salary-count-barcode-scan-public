import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@shared/utils/encryption';
import type { Employee } from '@shared/schema';

const directLookup = vi.hoisted(() => vi.fn(async (): Promise<Employee[]> => []));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: directLookup }) }) },
}));

import { DatabaseEmployeeRepository } from './employeeRepository';

function employee(identity = 'A123456789'): Employee {
  return {
    id: 7, name: 'Synthetic employee', idNumber: encrypt(identity), isEncrypted: true,
    department: null, position: null, email: null, phone: null, active: true,
    employeeType: 'local', specialLeaveDays: 0, specialLeaveWorkDateRange: null,
    specialLeaveUsedDates: [], specialLeaveCashDays: 0, specialLeaveCashMonth: null,
    specialLeaveNotes: null, deletedAt: null, deletedBy: null, purgeAfterAt: null,
    lineUserId: null, lineDisplayName: null, linePictureUrl: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  } as Employee;
}

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'synthetic-identity-cache-test-key-0000');
  vi.stubEnv('ENCRYPTION_SALT', 'synthetic-identity-cache-test-salt');
  directLookup.mockReset().mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('employee identity fallback cache after changes outside this repository instance', () => {
  async function warmedRepository() {
    const original = employee();
    const repository = new DatabaseEmployeeRepository();
    const all = vi.spyOn(repository, 'getAllEmployees').mockResolvedValue([original]);
    const current = vi.spyOn(repository, 'getEmployeeById').mockResolvedValue(original);
    expect(await repository.getEmployeeByIdNumber('A123456789')).toEqual(original);
    return { repository, original, all, current };
  }

  it('returns the current inactive state so scan authorization can reject it', async () => {
    const { repository, original, all, current } = await warmedRepository();
    current.mockResolvedValue({ ...original, active: false });
    expect(await repository.getEmployeeByIdNumber('A123456789')).toMatchObject({ active: false });
    expect(all).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached identity whose employee was removed or soft deleted', async () => {
    const { repository, current } = await warmedRepository();
    current.mockResolvedValue(undefined);
    expect(await repository.getEmployeeByIdNumber('A123456789')).toBeUndefined();
  });

  it('rejects the old identity after an external identity replacement and refreshes the next lookup', async () => {
    const { repository, all, current } = await warmedRepository();
    const replacement = employee('B123456789');
    current.mockResolvedValue(replacement);
    all.mockResolvedValue([replacement]);
    expect(await repository.getEmployeeByIdNumber('A123456789')).toBeUndefined();
    expect(await repository.getEmployeeByIdNumber('B123456789')).toEqual(replacement);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('accepts a fresh ciphertext for the same identity and returns current metadata', async () => {
    const { repository, current } = await warmedRepository();
    const replacement = { ...employee(), name: 'Synthetic current name' };
    current.mockResolvedValue(replacement);
    expect(await repository.getEmployeeByIdNumber('A123456789')).toEqual(replacement);
  });

  it('does not fall back to cached authority when the current lookup fails', async () => {
    const { repository, current } = await warmedRepository();
    current.mockRejectedValue(new Error('Synthetic database failure'));
    await expect(repository.getEmployeeByIdNumber('A123456789')).rejects.toThrow('Synthetic database failure');
  });

  it('keeps the direct identity match path to a single query', async () => {
    const original = employee();
    directLookup.mockResolvedValue([original]);
    const repository = new DatabaseEmployeeRepository();
    const byId = vi.spyOn(repository, 'getEmployeeById');
    const all = vi.spyOn(repository, 'getAllEmployees');
    expect(await repository.getEmployeeByIdNumber(original.idNumber)).toEqual(original);
    expect(directLookup).toHaveBeenCalledTimes(1);
    expect(byId).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
  });
});
