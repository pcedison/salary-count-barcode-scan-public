// Legacy Caesar shift used before AES migration (hardcoded here since the constant
// was removed from shared/constants.js after migration was completed).
const CAESAR_SHIFT = 9;
const AES_IV_HEX_LENGTH = 32;
const AES_TAG_HEX_LENGTH = 32;
const VALID_FIRST_LETTERS = new Set('ABCDEFGHIJKLMNOPQRSTUV'.split(''));
const SPECIAL_UNENCRYPTED_IDS = new Set(['E01839502']);
const KNOWN_ENCRYPTED_PATTERNS = new Set(['K011133456', 'N90728491']);
const LETTER_CODES = {
  A: 10,
  B: 11,
  C: 12,
  D: 13,
  E: 14,
  F: 15,
  G: 16,
  H: 17,
  I: 34,
  J: 18,
  K: 19,
  L: 20,
  M: 21,
  N: 22,
  O: 35,
  P: 23,
  Q: 24,
  R: 25,
  S: 26,
  T: 27,
  U: 28,
  V: 29,
  W: 32,
  X: 30,
  Y: 31,
  Z: 33
};

export function normalizeIdentity(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function caesarEncrypt(text) {
  return normalizeIdentity(text)
    .replace(/[A-Z]/g, (char) =>
      String.fromCharCode(((char.charCodeAt(0) - 65 + CAESAR_SHIFT) % 26) + 65)
    )
    .replace(/[0-9]/g, (char) =>
      String.fromCharCode(((char.charCodeAt(0) - 48 + CAESAR_SHIFT) % 10) + 48)
    );
}

export function caesarDecrypt(text) {
  return normalizeIdentity(text)
    .replace(/[A-Z]/g, (char) =>
      String.fromCharCode(((char.charCodeAt(0) - 65 - CAESAR_SHIFT + 26) % 26) + 65)
    )
    .replace(/[0-9]/g, (char) =>
      String.fromCharCode(((char.charCodeAt(0) - 48 - (CAESAR_SHIFT % 10) + 10) % 10) + 48)
    );
}

export function isAESEncrypted(value) {
  if (!value) {
    return false;
  }

  const parts = value.split(':');
  if (parts.length !== 3) {
    return false;
  }

  const [ivHex, tagHex, encrypted] = parts;
  const hexRe = /^[0-9a-fA-F]+$/;

  return (
    hexRe.test(ivHex) &&
    hexRe.test(tagHex) &&
    hexRe.test(encrypted) &&
    ivHex.length === AES_IV_HEX_LENGTH &&
    tagHex.length === AES_TAG_HEX_LENGTH
  );
}

export function isCaesarEncrypted(value) {
  const normalized = normalizeIdentity(value);
  if (!normalized) {
    return false;
  }

  if (KNOWN_ENCRYPTED_PATTERNS.has(normalized)) {
    return true;
  }

  if (SPECIAL_UNENCRYPTED_IDS.has(normalized) || isLikelyPlaintextIdentity(normalized)) {
    return false;
  }

  const decryptedCandidate = caesarDecrypt(normalized);
  return decryptedCandidate !== normalized && isLikelyPlaintextIdentity(decryptedCandidate);
}

export function isLikelyPlaintextIdentity(value) {
  const normalized = normalizeIdentity(value);

  if (!normalized) {
    return false;
  }

  if (SPECIAL_UNENCRYPTED_IDS.has(normalized)) {
    return true;
  }

  if (!/^[A-Z]\d{9}$/.test(normalized)) {
    return false;
  }

  const firstLetter = normalized[0];
  const letterCode = LETTER_CODES[firstLetter];

  if (!letterCode || !VALID_FIRST_LETTERS.has(firstLetter)) {
    return false;
  }

  const digits = normalized.slice(1).split('').map(Number);
  const checksum =
    Math.floor(letterCode / 10) +
    (letterCode % 10) * 9 +
    digits[0] * 8 +
    digits[1] * 7 +
    digits[2] * 6 +
    digits[3] * 5 +
    digits[4] * 4 +
    digits[5] * 3 +
    digits[6] * 2 +
    digits[7] +
    digits[8];

  return checksum % 10 === 0;
}

export function detectSourceFormat(idNumber, isEncryptedFlag) {
  const normalized = normalizeIdentity(idNumber);

  if (!normalized) {
    return 'empty';
  }

  if (isAESEncrypted(normalized)) {
    return 'aes';
  }

  if (isEncryptedFlag || isCaesarEncrypted(normalized)) {
    return 'caesar';
  }

  return 'plaintext';
}

export function isFlagMismatch(format, isEncryptedFlag) {
  if (format === 'plaintext') {
    return isEncryptedFlag === true;
  }

  if (format === 'caesar' || format === 'aes') {
    return isEncryptedFlag !== true;
  }

  return false;
}

export function maskIdentifier(value) {
  const normalized = normalizeIdentity(value);

  if (!normalized) {
    return '(empty)';
  }

  if (normalized.length <= 4) {
    return `${normalized.slice(0, 1)}***${normalized.slice(-1)}`;
  }

  return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`;
}

export function previewIdentifier(value, length = 30) {
  if (!value) {
    return '(empty)';
  }

  return value.length > length ? `${value.slice(0, length)}...` : value;
}

export function getPlaintextIdentity(options) {
  const { idNumber, isEncryptedFlag, aesDecrypt } = options;
  const normalized = normalizeIdentity(idNumber);

  if (!normalized) {
    return '';
  }

  const detectedFormat = detectSourceFormat(normalized, isEncryptedFlag);

  if (detectedFormat === 'aes') {
    return normalizeIdentity(aesDecrypt(normalized));
  }

  if (detectedFormat === 'caesar') {
    return normalizeIdentity(caesarDecrypt(normalized));
  }

  return normalized;
}

export function analyzeEmployeesForAesMigration(options) {
  const { employees, aesDecrypt, aesEncrypt } = options;
  const report = {
    counts: {
      total: employees.length,
      plaintext: 0,
      caesar: 0,
      aes: 0,
      empty: 0,
      alreadyAes: 0,
      toMigrate: 0,
      skipped: 0,
      flagMismatches: 0
    },
    findings: {
      flagMismatches: [],
      alreadyAes: [],
      migrationCandidates: [],
      skipped: []
    }
  };

  for (const employee of employees) {
    const normalizedStoredId = normalizeIdentity(employee.id_number);
    const format = detectSourceFormat(normalizedStoredId, employee.is_encrypted);
    const flagMismatch = isFlagMismatch(format, employee.is_encrypted === true);
    const common = {
      id: employee.id,
      name: employee.name,
      sourceFormat: format,
      isEncryptedFlag: employee.is_encrypted === true,
      flagMismatch,
      storedIdPreview: isAESEncrypted(normalizedStoredId)
        ? previewIdentifier(normalizedStoredId)
        : maskIdentifier(normalizedStoredId),
      maskedStoredId: maskIdentifier(normalizedStoredId)
    };

    report.counts[format] += 1;

    if (flagMismatch) {
      report.counts.flagMismatches += 1;
      report.findings.flagMismatches.push({
        ...common,
        expectedEncryptedFlag: format === 'plaintext' ? false : true
      });
    }

    if (format === 'aes') {
      report.counts.alreadyAes += 1;
      report.findings.alreadyAes.push(common);
      continue;
    }

    if (format === 'empty') {
      report.counts.skipped += 1;
      report.findings.skipped.push({
        ...common,
        reason: 'empty ID'
      });
      continue;
    }

    let plaintextId;
    try {
      plaintextId = getPlaintextIdentity({
        idNumber: employee.id_number,
        isEncryptedFlag: employee.is_encrypted === true,
        aesDecrypt
      });
    } catch (error) {
      report.counts.skipped += 1;
      report.findings.skipped.push({
        ...common,
        reason: `decrypt failed: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    if (!plaintextId) {
      report.counts.skipped += 1;
      report.findings.skipped.push({
        ...common,
        reason: 'could not derive plaintext identity'
      });
      continue;
    }

    const newCiphertext = aesEncrypt(plaintextId);
    let roundTripOk = false;

    try {
      roundTripOk = aesDecrypt(newCiphertext) === plaintextId;
    } catch {
      roundTripOk = false;
    }

    report.counts.toMigrate += 1;
    report.findings.migrationCandidates.push({
      ...common,
      oldIdNumber: employee.id_number,
      oldIsEncrypted: employee.is_encrypted === true,
      plaintextId,
      maskedPlaintextId: maskIdentifier(plaintextId),
      newCiphertext,
      newCiphertextPreview: previewIdentifier(newCiphertext),
      roundTripOk
    });
  }

  return report;
}

export function sanitizeAesMigrationReportForDisk(report) {
  return {
    counts: report.counts,
    findings: {
      flagMismatches: report.findings.flagMismatches.map((item) => ({
        id: item.id,
        name: item.name,
        sourceFormat: item.sourceFormat,
        isEncryptedFlag: item.isEncryptedFlag,
        expectedEncryptedFlag: item.expectedEncryptedFlag,
        storedIdPreview: item.storedIdPreview,
        maskedStoredId: item.maskedStoredId
      })),
      alreadyAes: report.findings.alreadyAes.map((item) => ({
        id: item.id,
        name: item.name,
        sourceFormat: item.sourceFormat,
        isEncryptedFlag: item.isEncryptedFlag,
        storedIdPreview: item.storedIdPreview,
        maskedStoredId: item.maskedStoredId
      })),
      migrationCandidates: report.findings.migrationCandidates.map((item) => ({
        id: item.id,
        name: item.name,
        sourceFormat: item.sourceFormat,
        isEncryptedFlag: item.isEncryptedFlag,
        flagMismatch: item.flagMismatch,
        maskedPlaintextId: item.maskedPlaintextId,
        storedIdPreview: item.storedIdPreview,
        newCiphertextPreview: item.newCiphertextPreview,
        roundTripOk: item.roundTripOk
      })),
      skipped: report.findings.skipped.map((item) => ({
        id: item.id,
        name: item.name,
        sourceFormat: item.sourceFormat,
        isEncryptedFlag: item.isEncryptedFlag,
        flagMismatch: item.flagMismatch,
        storedIdPreview: item.storedIdPreview,
        maskedStoredId: item.maskedStoredId,
        reason: item.reason
      }))
    }
  };
}
