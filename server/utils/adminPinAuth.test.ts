import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  hashAdminPin,
  isHashedPin,
  needsRehash,
  verifyHashedAdminPin,
  verifyStoredAdminPin
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
