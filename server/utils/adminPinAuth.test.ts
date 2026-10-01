import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hashAdminPin,
  hashAdminPinAsync,
  ADMIN_PIN_WORK_LIMITS,
  AdminPinBusyError,
  isHashedPin,
  needsRehash,
  verifyHashedAdminPin,
  verifyHashedAdminPinAsync,
  verifyStoredAdminPin,
  verifyStoredAdminPinAsync
} from './adminPinAuth';

/** Create a legacy 2-part hash (salt:hash) with 1,000 iterations for testing. */
function legacyHash(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, 1_000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

describe('adminPinAuth', () => {
  it('rejects plaintext PIN values', () => {
    expect(verifyStoredAdminPin('246810', '246810')).toBe(false);
    expect(verifyStoredAdminPin('246810', '123456')).toBe(false);
  });

  it('hashes a PIN in new 3-part format and verifies', () => {
    const hashedPin = hashAdminPin('246810');
    const parts = hashedPin.split(':');

    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe('600000');
    expect(isHashedPin(hashedPin)).toBe(true);
    expect(verifyHashedAdminPin(hashedPin, '246810')).toBe(true);
    expect(verifyHashedAdminPin(hashedPin, '123456')).toBe(false);
  });

  it('verifies legacy 2-part hashes (backward compatibility)', () => {
    const legacy = legacyHash('mypin');

    expect(legacy.split(':')).toHaveLength(2);
    expect(isHashedPin(legacy)).toBe(true);
    expect(verifyHashedAdminPin(legacy, 'mypin')).toBe(true);
    expect(verifyHashedAdminPin(legacy, 'wrong')).toBe(false);
  });

  it('needsRehash returns true for legacy hashes, false for current', () => {
    const legacy = legacyHash('pin1');
    const current = hashAdminPin('pin2');

    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(current)).toBe(false);
  });

  it('verifies stored PIN values regardless of plaintext or hashed format', () => {
    const hashedPin = hashAdminPin('135790');

    expect(verifyStoredAdminPin(hashedPin, '135790')).toBe(true);
    expect(verifyStoredAdminPin(hashedPin, '000000')).toBe(false);
  });

  it('rejects malformed hashes gracefully', () => {
    expect(verifyHashedAdminPin('', 'pin')).toBe(false);
    expect(verifyHashedAdminPin('onlyonepart', 'pin')).toBe(false);
    expect(verifyHashedAdminPin('a:b:c:d', 'pin')).toBe(false);
    expect(isHashedPin('')).toBe(false);
    expect(needsRehash('')).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded asynchronous admin PIN work', () => {
  it('keeps the event loop responsive while creating a compatible current hash', async () => {
    let completed = false;
    const hashing = hashAdminPinAsync('495827').then(hash => {
      completed = true;
      return hash;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    const hash = await hashing;
    expect(hash).toMatch(/^[0-9a-f]{32}:600000:[0-9a-f]{128}$/);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyStoredAdminPinAsync(hash, '495827')).toBe(true);
    expect(await verifyStoredAdminPinAsync(hash, '000001')).toBe(false);
  });

  it('accepts existing legacy and lower-iteration hashes without plaintext fallback', async () => {
    const legacy = legacyHash('legacy-pin');
    expect(await verifyHashedAdminPinAsync(legacy, 'legacy-pin')).toBe(true);
    const [salt, hash] = legacy.split(':');
    expect(await verifyStoredAdminPinAsync(`${salt}:1000:${hash}`, 'legacy-pin')).toBe(true);
    expect(needsRehash(`${salt}:1000:${hash}`)).toBe(true);
    expect(await verifyStoredAdminPinAsync('legacy-pin', 'legacy-pin')).toBe(false);
  });

  it('rejects malformed hashes and non-string or oversized PIN input before scheduling crypto', async () => {
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');
    const salt = 'ab'.repeat(16);
    const hash = 'cd'.repeat(64);
    for (const stored of [
      `${salt}:600000suffix:${hash}`, `${salt}:0:${hash}`, `${salt}:-1:${hash}`,
      `${salt}:2000001:${hash}`, `${salt}:Infinity:${hash}`, `${salt}:1e3:${hash}`,
      `${salt}:1000:${hash.slice(1)}`, `a:1000:${hash}`, `${salt}:1000:xy`,
    ]) {
      expect(isHashedPin(stored)).toBe(false);
      expect(await verifyHashedAdminPinAsync(stored, '495827')).toBe(false);
    }
    for (const pin of [null, 495827, {}, [], '', 'a'.repeat(129), '漢'.repeat(43)]) {
      expect(await verifyStoredAdminPinAsync(`${salt}:1000:${hash}`, pin as string)).toBe(false);
      await expect(hashAdminPinAsync(pin as string)).rejects.toThrow('Invalid PIN input');
    }
    expect(pbkdf2).not.toHaveBeenCalled();
  });

  it('bounds native concurrency and queue length, rejects overflow, and drains queued jobs', async () => {
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    let running = 0;
    let maximumRunning = 0;
    vi.spyOn(crypto, 'pbkdf2').mockImplementation((...args: any[]) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      callbacks.push(args[5]);
    });
    const count = ADMIN_PIN_WORK_LIMITS.concurrency + ADMIN_PIN_WORK_LIMITS.queued;
    const jobs = Array.from({ length: count }, () => hashAdminPinAsync('495827'));
    try {
      expect(callbacks).toHaveLength(ADMIN_PIN_WORK_LIMITS.concurrency);
      await expect(hashAdminPinAsync('495827')).rejects.toMatchObject({ code: 'AUTH_BUSY', status: 503 });
    } finally {
      while (callbacks.length) {
        running -= 1;
        callbacks.shift()!(null, Buffer.alloc(64));
      }
      await Promise.all(jobs);
    }
    expect(maximumRunning).toBe(ADMIN_PIN_WORK_LIMITS.concurrency);
    expect(running).toBe(0);
    // Capacity is reusable after the entire queue drains.
    const next = hashAdminPinAsync('495827');
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(null, Buffer.alloc(64));
    await next;
  });

  it('expires a waiting job without starting it and frees its queue capacity', async () => {
    vi.useFakeTimers();
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2').mockImplementation((...args: any[]) => callbacks.push(args[5]));
    const active = Array.from({ length: ADMIN_PIN_WORK_LIMITS.concurrency }, () => hashAdminPinAsync('495827'));
    const waiting = hashAdminPinAsync('495827').catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(ADMIN_PIN_WORK_LIMITS.queueTimeoutMs);
      expect(await waiting).toBeInstanceOf(AdminPinBusyError);
      expect(pbkdf2).toHaveBeenCalledTimes(ADMIN_PIN_WORK_LIMITS.concurrency);
    } finally {
      while (callbacks.length) callbacks.shift()!(null, Buffer.alloc(64));
      await Promise.all(active);
    }
    const next = hashAdminPinAsync('495827');
    callbacks.shift()!(null, Buffer.alloc(64));
    await next;
  });

  it('releases native slots on crypto failure and fails verification closed', async () => {
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    vi.spyOn(crypto, 'pbkdf2').mockImplementation((...args: any[]) => callbacks.push(args[5]));
    const hash = `${'ab'.repeat(16)}:1000:${'cd'.repeat(64)}`;
    const jobs = Array.from({ length: 3 }, () => verifyStoredAdminPinAsync(hash, '495827'));
    callbacks.shift()!(new Error('synthetic crypto failure'), Buffer.alloc(64));
    while (callbacks.length) callbacks.shift()!(null, Buffer.alloc(64));
    expect(await Promise.all(jobs)).toEqual([false, false, false]);
  });
});
