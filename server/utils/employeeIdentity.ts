import { decrypt as decryptAes, encrypt as encryptAes, isAESEncrypted } from '@shared/utils/encryption';

import { createLogger } from './logger';

const log = createLogger('identity');

type EmployeeIdentityLike = {
  idNumber: string;
  isEncrypted?: boolean | null;
};

export function normalizeEmployeeIdentity(value: string): string {
  return value.trim().toUpperCase();
}

export function maskEmployeeIdentityForLog(rawIdNumber: string): string {
  const trimmedId = rawIdNumber.trim();

  if (!trimmedId) {
    return '[empty-id]';
  }

  let displayId = normalizeEmployeeIdentity(trimmedId);

  try {
    if (isAESEncrypted(trimmedId)) {
      displayId = normalizeEmployeeIdentity(decryptAes(trimmedId));
    }
  } catch {
    return `[protected-id:${trimmedId.length}]`;
  }

  if (displayId.length <= 4) {
    return `${displayId.slice(0, 1)}***${displayId.slice(-1)}`;
  }

  return `${displayId.slice(0, 2)}${'*'.repeat(displayId.length - 4)}${displayId.slice(-2)}`;
}

export function isAesWriteEnabled(): boolean {
  return process.env.USE_AES_ENCRYPTION === 'true' && Boolean(process.env.ENCRYPTION_KEY);
}

/**
 * 若輸入值為 AES 加密，自動解密還原；否則原樣正規化回傳。
 * Caesar cipher 已廢除，不再嘗試 Caesar 解密。
 */
function maybeDecryptInputIdentity(rawIdNumber: string): string {
  const trimmedId = rawIdNumber.trim();
  const normalizedId = normalizeEmployeeIdentity(trimmedId);

  if (!trimmedId) {
    return '';
  }

  try {
    if (isAESEncrypted(trimmedId)) {
      return normalizeEmployeeIdentity(decryptAes(trimmedId));
    }
  } catch (error) {
    log.error('身分證號碼解密失敗:', error);
  }

  return normalizedId;
}

/**
 * 取得員工顯示用的明文 ID。
 * - 若 DB 儲存的是 AES 密文，自動解密。
 * - isEncrypted = false 且非 AES 格式：直接回傳儲存值（信任旗標）。
 * Caesar cipher 已廢除，不再做 Caesar 自動偵測。
 */
export function getEmployeeDisplayId(employee: EmployeeIdentityLike): string {
  const normalizedStoredId = normalizeEmployeeIdentity(employee.idNumber || '');

  if (!normalizedStoredId) {
    return '';
  }

  // AES 密文不論 isEncrypted 旗標一律解密
  if (isAESEncrypted(normalizedStoredId)) {
    try {
      return normalizeEmployeeIdentity(decryptAes(normalizedStoredId));
    } catch (error) {
      log.error('AES 解密失敗:', error);
      return normalizedStoredId;
    }
  }

  // isEncrypted = true 但非 AES 格式：尚未遷移的舊 Caesar 資料，原樣回傳並警告
  if (employee.isEncrypted) {
    log.warn(`員工 ID 標記為已加密但非 AES 格式，可能是未遷移的舊資料: ${maskEmployeeIdentityForLog(normalizedStoredId)}`);
  }

  return normalizedStoredId;
}

/**
 * 取得員工掃碼用 ID。
 * 移除 Caesar 加密後，掃碼 ID 與顯示 ID 一致（明文）。
 */
export function getEmployeeScanId(employee: EmployeeIdentityLike): string {
  return getEmployeeDisplayId(employee);
}

export function buildEmployeeIdentityLookupCandidates(rawIdNumber: string): string[] {
  const trimmedId = rawIdNumber.trim();
  if (!trimmedId) {
    return [];
  }

  const normalizedId = normalizeEmployeeIdentity(trimmedId);
  const displayId = maybeDecryptInputIdentity(trimmedId);

  const candidates = new Set<string>();

  candidates.add(trimmedId);

  if (normalizedId !== trimmedId) {
    candidates.add(normalizedId);
  }

  // AES 密文的小寫形式（容錯）
  if (isAESEncrypted(trimmedId)) {
    candidates.add(trimmedId.toLowerCase());
  }

  if (displayId && displayId !== normalizedId) {
    candidates.add(displayId);
  }

  return Array.from(candidates).filter(Boolean);
}

export function encryptEmployeeIdentityForStorage(
  idNumber: string,
  shouldEncrypt: boolean
): string {
  const normalizedId = normalizeEmployeeIdentity(idNumber);

  if (!normalizedId || !shouldEncrypt) {
    return normalizedId;
  }

  if (isAesWriteEnabled()) {
    return encryptAes(normalizedId);
  }

  // AES 未設定時儲存明文並警告（Caesar cipher 已廢除）
  log.warn('要求加密但 AES 未設定，以明文儲存身分資訊');
  return normalizedId;
}

export function prepareUpdatedEmployeeIdentityForStorage(options: {
  currentEmployee: EmployeeIdentityLike;
  nextIdNumber?: string | null;
  shouldEncrypt: boolean;
}): string {
  const { currentEmployee, nextIdNumber, shouldEncrypt } = options;
  const currentStoredId = (currentEmployee.idNumber || '').trim();
  const currentDisplayId = getEmployeeDisplayId(currentEmployee);
  const hasExplicitIdUpdate = typeof nextIdNumber === 'string';
  const nextDisplayId = hasExplicitIdUpdate
    ? normalizeEmployeeIdentity(nextIdNumber || '')
    : currentDisplayId;

  if (!nextDisplayId) {
    return nextDisplayId;
  }

  // 使用者提交的值與當前顯示值相同 → 保留原始儲存位元組，避免重複編碼
  if (nextDisplayId === currentDisplayId && currentStoredId) {
    return currentStoredId;
  }

  // 使用者提交的是 AES 密文形式的當前 ID（少見但可能） → 同樣保留
  const nextDecoded = maybeDecryptInputIdentity(nextDisplayId);
  if (nextDecoded === currentDisplayId && currentStoredId) {
    return currentStoredId;
  }

  if (!shouldEncrypt) {
    return nextDisplayId;
  }

  return encryptEmployeeIdentityForStorage(nextDisplayId, true);
}

export function matchesEmployeeIdentity(
  employee: EmployeeIdentityLike,
  rawIdNumber: string
): boolean {
  const inputCandidates = new Set(buildEmployeeIdentityLookupCandidates(rawIdNumber).map(normalizeEmployeeIdentity));
  if (inputCandidates.size === 0) {
    return false;
  }

  const storedId = normalizeEmployeeIdentity(employee.idNumber || '');
  const displayId = getEmployeeDisplayId(employee);

  return [storedId, displayId].some((candidate) =>
    inputCandidates.has(normalizeEmployeeIdentity(candidate))
  );
}
