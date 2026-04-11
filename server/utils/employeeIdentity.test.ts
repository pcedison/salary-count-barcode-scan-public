import { afterEach, describe, expect, it } from 'vitest';

import { decrypt as decryptAes, encrypt as encryptAes, isAESEncrypted } from '@shared/utils/encryption';

import {
  buildEmployeeIdentityLookupCandidates,
  encryptEmployeeIdentityForStorage,
  getEmployeeDisplayId,
  getEmployeeScanId,
  isAesWriteEnabled,
  maskEmployeeIdentityForLog,
  matchesEmployeeIdentity,
  normalizeEmployeeIdentity,
  prepareUpdatedEmployeeIdentityForStorage
} from './employeeIdentity';

const TEST_ENCRYPTION_KEY = '12345678901234567890123456789012';

describe('employeeIdentity', () => {
  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.USE_AES_ENCRYPTION;
  });

  it('normalizes employee identities to trimmed uppercase values', () => {
    expect(normalizeEmployeeIdentity(' a123456789 ')).toBe('A123456789');
  });

  it('builds lookup candidates for plaintext and AES inputs', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const aesId = encryptAes('A123456789');

    // Plain text: just the normalized value
    expect(buildEmployeeIdentityLookupCandidates('A123456789')).toEqual(['A123456789']);

    // AES encrypted: include ciphertext, its lowercase form, and decrypted plain
    const aesCandidates = buildEmployeeIdentityLookupCandidates(aesId);
    expect(aesCandidates).toContain(aesId);
    expect(aesCandidates).toContain(aesId.toLowerCase());
    expect(aesCandidates).toContain('A123456789');
  });

  it('returns display ids for plaintext employees', () => {
    const plainEmployee = { idNumber: 'a123456789', isEncrypted: false };

    expect(getEmployeeDisplayId(plainEmployee)).toBe('A123456789');
    // scan id is now the same as display id (no Caesar)
    expect(getEmployeeScanId(plainEmployee)).toBe('A123456789');
  });

  it('supports AES-encrypted employee ids for display and scan matching', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const aesId = encryptAes('A123456789');
    const aesEmployee = { idNumber: aesId, isEncrypted: true };

    expect(getEmployeeDisplayId(aesEmployee)).toBe('A123456789');
    expect(getEmployeeScanId(aesEmployee)).toBe('A123456789');
    expect(matchesEmployeeIdentity(aesEmployee, 'A123456789')).toBe(true);
    expect(matchesEmployeeIdentity(aesEmployee, aesId)).toBe(true);
  });

  it('masks plaintext and AES-encrypted employee identities before logging', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const aesId = encryptAes('A123456789');

    expect(maskEmployeeIdentityForLog('A123456789')).toBe('A1******89');
    expect(maskEmployeeIdentityForLog(aesId)).toBe('A1******89');
  });

  it('uses AES writes when feature flag is enabled and preserves stored value when id is unchanged', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.USE_AES_ENCRYPTION = 'true';

    const aesStoredId = encryptEmployeeIdentityForStorage('A123456789', true);
    const aesEmployee = { idNumber: aesStoredId, isEncrypted: true };

    expect(isAesWriteEnabled()).toBe(true);
    expect(isAESEncrypted(aesStoredId)).toBe(true);
    // Submitting display value back preserves the original AES ciphertext
    expect(prepareUpdatedEmployeeIdentityForStorage({
      currentEmployee: aesEmployee,
      nextIdNumber: 'A123456789',
      shouldEncrypt: true
    })).toBe(aesStoredId);
  });

  it('re-encrypts changed ids with AES when the feature flag is enabled', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.USE_AES_ENCRYPTION = 'true';

    const nextStoredId = prepareUpdatedEmployeeIdentityForStorage({
      currentEmployee: { idNumber: encryptAes('A123456789'), isEncrypted: true },
      nextIdNumber: 'A123456780',
      shouldEncrypt: true
    });

    expect(isAESEncrypted(nextStoredId)).toBe(true);
    expect(decryptAes(nextStoredId)).toBe('A123456780');
  });

  it('stores plain text when encryption is disabled', () => {
    // AES not configured → plain text (Caesar cipher removed)
    const storedId = encryptEmployeeIdentityForStorage('A123456789', true);
    expect(isAesWriteEnabled()).toBe(false);
    expect(storedId).toBe('A123456789');
  });

  it('preserves original stored bytes when submitting the display value unchanged', () => {
    const plainEmployee = { idNumber: 'E01839502', isEncrypted: false };

    const result = prepareUpdatedEmployeeIdentityForStorage({
      currentEmployee: plainEmployee,
      nextIdNumber: 'E01839502',
      shouldEncrypt: false
    });

    expect(result).toBe('E01839502');
  });
});
