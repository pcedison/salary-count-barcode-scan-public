import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScanDedupGuard,
  buildScanUnlockTokenPayload,
  consumeScanUnlockTokenNonce,
  decodeScanUnlockToken,
  encodeScanUnlockToken,
  hasValidDeviceTokenValue,
} from './scanSecurity.service';

describe('scan unlock token', () => {
  beforeEach(() => {
    process.env.SCAN_UNLOCK_TOKEN_SECRET = 'test-secret-for-scan-unlock-token';
  });

  afterEach(() => {
    delete process.env.SCAN_UNLOCK_TOKEN_SECRET;
    vi.useRealTimers();
  });

  it('round-trips a payload through encode and decode', () => {
    const payload = buildScanUnlockTokenPayload('kiosk-challenge-1');
    const decoded = decodeScanUnlockToken(encodeScanUnlockToken(payload));

    expect(decoded).toEqual(payload);
  });

  it('rejects tokens with a tampered signature', () => {
    const token = encodeScanUnlockToken(buildScanUnlockTokenPayload('kiosk-challenge-1'));
    const [encodedPayload] = token.split('.');

    expect(decodeScanUnlockToken(`${encodedPayload}.forged-signature`)).toBeNull();
    expect(decodeScanUnlockToken('not-a-token')).toBeNull();
  });

  it('rejects tokens whose payload was modified after signing', () => {
    const token = encodeScanUnlockToken(buildScanUnlockTokenPayload('kiosk-challenge-1'));
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...buildScanUnlockTokenPayload('kiosk-challenge-2') }),
      'utf8'
    ).toString('base64url');

    expect(decodeScanUnlockToken(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it('consumes a nonce exactly once and rejects replays', () => {
    const payload = buildScanUnlockTokenPayload('kiosk-challenge-1');

    expect(consumeScanUnlockTokenNonce(payload)).toBe(true);
    expect(consumeScanUnlockTokenNonce(payload)).toBe(false);
  });

  it('rejects expired tokens', () => {
    const payload = buildScanUnlockTokenPayload('kiosk-challenge-1');
    vi.useFakeTimers();
    vi.setSystemTime(payload.expiresAt + 1);

    expect(consumeScanUnlockTokenNonce(payload)).toBe(false);
  });
});

describe('device token validation', () => {
  it('accepts only an exact match via timing-safe comparison', () => {
    expect(hasValidDeviceTokenValue('expected-token', 'expected-token')).toBe(true);
    expect(hasValidDeviceTokenValue('expected-token', 'wrong-token!!')).toBe(false);
    expect(hasValidDeviceTokenValue('expected-token', '')).toBe(false);
  });
});

describe('ScanDedupGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first scan and blocks a rapid duplicate of the same action', () => {
    const guard = new ScanDedupGuard(2000);

    expect(guard.tryAcquire(9, 'clockIn')).toBe(true);
    expect(guard.tryAcquire(9, 'clockIn')).toBe(false);
  });

  it('does not block a clock-in → clock-out transition', () => {
    const guard = new ScanDedupGuard(2000);

    expect(guard.tryAcquire(9, 'clockIn')).toBe(true);
    expect(guard.tryAcquire(9, 'clockOut')).toBe(true);
  });

  it('allows the same action again after the window has passed and prunes old entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const guard = new ScanDedupGuard(2000);

    expect(guard.tryAcquire(9, 'clockIn')).toBe(true);
    vi.setSystemTime(2000);
    expect(guard.tryAcquire(9, 'clockIn')).toBe(true);
    expect(guard.size).toBe(1);
  });
});
