import crypto from 'crypto';

import type { AttendanceScanAction } from '../storage';

/**
 * 掃描端點的安全機制,從 scan.routes.ts 抽出的 service 層:
 * - kiosk 解鎖 token:HMAC-SHA256 簽章 + 一次性 nonce 防重放
 * - 裝置 token:timing-safe 比對
 * - ScanDedupGuard:短窗口內的重複掃描防護(每次註冊路由各自實例化,
 *   維持測試隔離;in-memory 設計假設單一 process 部署)
 */

export const SCAN_UNLOCK_TOKEN_TTL_MS = 10 * 60 * 1000;

export type ScanUnlockTokenPayload = {
  scope: 'scan_unlock';
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  kioskChallenge: string;
};

const usedScanUnlockTokenNonces = new Map<string, number>();

function resolveScanUnlockTokenSecret(): string {
  return (
    process.env.SCAN_UNLOCK_TOKEN_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    'development-scan-unlock-secret-do-not-use'
  );
}

export function buildScanUnlockTokenPayload(kioskChallenge: string): ScanUnlockTokenPayload {
  const issuedAt = Date.now();
  return {
    scope: 'scan_unlock',
    issuedAt,
    expiresAt: issuedAt + SCAN_UNLOCK_TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
    kioskChallenge
  };
}

export function encodeScanUnlockToken(payload: ScanUnlockTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', resolveScanUnlockTokenSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

export function decodeScanUnlockToken(token: string): ScanUnlockTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', resolveScanUnlockTokenSecret())
    .update(encodedPayload)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<ScanUnlockTokenPayload>;

    if (
      decoded?.scope !== 'scan_unlock' ||
      typeof decoded.issuedAt !== 'number' ||
      typeof decoded.expiresAt !== 'number' ||
      typeof decoded.nonce !== 'string' ||
      typeof decoded.kioskChallenge !== 'string'
    ) {
      return null;
    }

    return {
      scope: 'scan_unlock',
      issuedAt: decoded.issuedAt,
      expiresAt: decoded.expiresAt,
      nonce: decoded.nonce,
      kioskChallenge: decoded.kioskChallenge
    };
  } catch {
    return null;
  }
}

function cleanupExpiredScanUnlockTokens(now: number): void {
  for (const [nonce, expiresAt] of Array.from(usedScanUnlockTokenNonces.entries())) {
    if (expiresAt <= now) {
      usedScanUnlockTokenNonces.delete(nonce);
    }
  }
}

/** 一次性消耗 nonce:過期或已用過的 token 一律拒絕(防重放)。 */
export function consumeScanUnlockTokenNonce(payload: ScanUnlockTokenPayload): boolean {
  const now = Date.now();
  cleanupExpiredScanUnlockTokens(now);

  if (payload.expiresAt <= now) {
    return false;
  }

  if (usedScanUnlockTokenNonces.has(payload.nonce)) {
    return false;
  }

  usedScanUnlockTokenNonces.set(payload.nonce, payload.expiresAt);
  return true;
}

/** timing-safe 比對裝置 token 值。 */
export function hasValidDeviceTokenValue(expected: string, provided: string): boolean {
  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

/**
 * 短窗口重複掃描防護。以 (employeeId, action) 為 key,
 * 因此 clockIn → clockOut 的正常轉換不會被擋。
 */
export class ScanDedupGuard {
  private readonly recentScans = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** 嘗試取得掃描權:窗口內同 key 的第二次呼叫回傳 false。順手清掉過期項目。 */
  tryAcquire(employeeId: number, action: AttendanceScanAction): boolean {
    const now = Date.now();
    const key = `${employeeId}-${action}`;

    const lastScan = this.recentScans.get(key);
    if (lastScan !== undefined && now - lastScan < this.windowMs) {
      return false;
    }

    this.recentScans.set(key, now);
    for (const [existingKey, timestamp] of Array.from(this.recentScans.entries())) {
      if (now - timestamp >= this.windowMs) {
        this.recentScans.delete(existingKey);
      }
    }
    return true;
  }

  get size(): number {
    return this.recentScans.size;
  }
}
