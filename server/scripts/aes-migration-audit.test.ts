import { describe, expect, it } from 'vitest';

import {
  analyzeEmployeesForAesMigration,
  caesarEncrypt,
  detectSourceFormat,
  isFlagMismatch,
  sanitizeAesMigrationReportForDisk
} from '../../scripts/lib/aes-migration-audit.mjs';

describe('aes migration audit', () => {
  it('detects plaintext, caesar, aes, and empty identity formats', () => {
    expect(detectSourceFormat('A123456789', false)).toBe('plaintext');
    expect(detectSourceFormat(caesarEncrypt('A123456789'), false)).toBe('caesar');
    expect(detectSourceFormat('E01839502', false)).toBe('plaintext');
    expect(detectSourceFormat('a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(24), true)).toBe('aes');
    expect(detectSourceFormat('', false)).toBe('empty');
  });

  it('tracks flag mismatches for protected and plaintext ids', () => {
    expect(isFlagMismatch('plaintext', true)).toBe(true);
    expect(isFlagMismatch('caesar', false)).toBe(true);
    expect(isFlagMismatch('aes', false)).toBe(true);
    expect(isFlagMismatch('plaintext', false)).toBe(false);
  });

  it('builds a sanitized dry-run report with counts and mismatch findings', () => {
    const caesarId = caesarEncrypt('A123456789');
    const analysis = analyzeEmployeesForAesMigration({
      employees: [
        { id: 1, name: 'Plain', id_number: 'A123456789', is_encrypted: false },
        { id: 2, name: 'CaesarMismatch', id_number: caesarId, is_encrypted: false },
        { id: 3, name: 'AlreadyAes', id_number: 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(24), is_encrypted: true },
        { id: 4, name: 'Empty', id_number: '', is_encrypted: false }
      ],
      aesEncrypt: (plaintext: string) => `enc:${plaintext}`,
      aesDecrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, '')
    });

    expect(analysis.counts).toMatchObject({
      total: 4,
      plaintext: 1,
      caesar: 1,
      aes: 1,
      empty: 1,
      alreadyAes: 1,
      toMigrate: 2,
      skipped: 1,
      flagMismatches: 1
    });
    expect(analysis.findings.flagMismatches).toHaveLength(1);
    expect(analysis.findings.migrationCandidates).toEqual([
      expect.objectContaining({
        id: 1,
        sourceFormat: 'plaintext',
        roundTripOk: true
      }),
      expect.objectContaining({
        id: 2,
        sourceFormat: 'caesar',
        flagMismatch: true,
        roundTripOk: true
      })
    ]);

    const sanitized = sanitizeAesMigrationReportForDisk(analysis);
    expect(sanitized.findings.migrationCandidates[0]).not.toHaveProperty('plaintextId');
    expect(sanitized.findings.migrationCandidates[0]).not.toHaveProperty('newCiphertext');
    expect(sanitized.findings.migrationCandidates[0]).toEqual(
      expect.objectContaining({
        id: 1,
        sourceFormat: 'plaintext',
        storedIdPreview: 'A1****89',
        roundTripOk: true
      })
    );
  });
});
