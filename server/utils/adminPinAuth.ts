import crypto from 'crypto';

const HASH_SEPARATOR = ':';
const CURRENT_ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 1_000;

const HEX_PATTERN = /^[0-9a-f]+$/i;

/**
 * Parse a stored hash into its components.
 * Supports two formats:
 *   - Legacy:  salt:hash              (assumed 1,000 iterations)
 *   - Current: salt:iterations:hash   (iteration count embedded)
 *
 * Both salt and hash must be non-empty hex strings to avoid false positives
 * when plaintext values happen to contain colons.
 */
function parseHashParts(stored: string): { salt: string; iterations: number; hash: string } | null {
  const parts = stored.split(HASH_SEPARATOR);

  if (parts.length === 3) {
    const [salt, iterStr, hash] = parts;
    const iterations = parseInt(iterStr, 10);
    if (
      salt && HEX_PATTERN.test(salt) &&
      hash && HEX_PATTERN.test(hash) &&
      !Number.isNaN(iterations) && iterations > 0
    ) {
      return { salt, iterations, hash };
    }
  }

  if (parts.length === 2) {
    const [salt, hash] = parts;
    if (salt && HEX_PATTERN.test(salt) && hash && HEX_PATTERN.test(hash)) {
      return { salt, iterations: LEGACY_ITERATIONS, hash };
    }
  }

  return null;
}

export function isHashedPin(value: string): boolean {
  if (!value) return false;
  return parseHashParts(value) !== null;
}

/**
 * Returns true if the stored hash uses fewer iterations than CURRENT_ITERATIONS
 * and should be re-hashed on next successful verification.
 */
export function needsRehash(storedHash: string): boolean {
  const parts = parseHashParts(storedHash);
  if (!parts) return false;
  return parts.iterations < CURRENT_ITERATIONS;
}

export function hashAdminPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, CURRENT_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${CURRENT_ITERATIONS}:${hash}`;
}

export function verifyHashedAdminPin(storedHash: string, providedPin: string): boolean {
  const parts = parseHashParts(storedHash);
  if (!parts) return false;

  const providedHashBuf = crypto.pbkdf2Sync(
    providedPin, parts.salt, parts.iterations, 64, 'sha512'
  );
  const storedHashBuf = Buffer.from(parts.hash, 'hex');

  if (providedHashBuf.length !== storedHashBuf.length) return false;
  return crypto.timingSafeEqual(providedHashBuf, storedHashBuf);
}

export function verifyStoredAdminPin(storedPin: string, providedPin: string): boolean {
  if (!storedPin || !providedPin) {
    return false;
  }

  if (isHashedPin(storedPin)) {
    return verifyHashedAdminPin(storedPin, providedPin);
  }

  // Plaintext PIN detected — hash it on first successful match and warn
  // This path exists only for migration from legacy plaintext PINs
  return false;
}
