import crypto from 'crypto';

const HASH_SEPARATOR = ':';
const CURRENT_ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 1_000;
const MAX_STORED_ITERATIONS = 2_000_000;
const MAX_PIN_BYTES = 128;

const SALT_PATTERN = /^[0-9a-f]{32}$/i;
const HASH_PATTERN = /^[0-9a-f]{128}$/i;

// Leave capacity in the default libuv pool for file and DNS operations.
export const ADMIN_PIN_WORK_LIMITS = Object.freeze({ concurrency: 2, queued: 8, queueTimeoutMs: 5_000 });

export class AdminPinBusyError extends Error {
  readonly code = 'AUTH_BUSY';
  readonly status = 503;

  constructor() {
    super('Authentication is temporarily busy. Please retry.');
    this.name = 'AdminPinBusyError';
  }
}

export function isSupportedPinInput(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_PIN_BYTES && Buffer.byteLength(value, 'utf8') <= MAX_PIN_BYTES;
}

type QueuedDerivation = { start: () => void; timer: ReturnType<typeof setTimeout> };
let activeDerivations = 0;
const pendingDerivations: QueuedDerivation[] = [];

function derivePinAsync(pin: string, salt: string, iterations: number): Promise<Buffer> {
  if (activeDerivations >= ADMIN_PIN_WORK_LIMITS.concurrency &&
      pendingDerivations.length >= ADMIN_PIN_WORK_LIMITS.queued) {
    return Promise.reject(new AdminPinBusyError());
  }

  return new Promise((resolve, reject) => {
    const release = () => {
      activeDerivations -= 1;
      const next = pendingDerivations.shift();
      if (next) {
        clearTimeout(next.timer);
        next.start();
      }
    };
    const start = () => {
      activeDerivations += 1;
      try {
        crypto.pbkdf2(pin, salt, iterations, 64, 'sha512', (error, derivedKey) => {
          release();
          if (error) reject(error);
          else resolve(derivedKey);
        });
      } catch (error) {
        release();
        reject(error);
      }
    };

    if (activeDerivations < ADMIN_PIN_WORK_LIMITS.concurrency) {
      start();
      return;
    }

    const queued: QueuedDerivation = {
      start,
      timer: setTimeout(() => {
        const index = pendingDerivations.indexOf(queued);
        if (index !== -1) {
          pendingDerivations.splice(index, 1);
          reject(new AdminPinBusyError());
        }
      }, ADMIN_PIN_WORK_LIMITS.queueTimeoutMs),
    };
    pendingDerivations.push(queued);
  });
}

/**
 * Parse a stored hash into its components.
 * Supports two formats:
 *   - Legacy:  salt:hash              (assumed 1,000 iterations)
 *   - Current: salt:iterations:hash   (iteration count embedded)
 *
 * Salt and digest lengths match the generated hashes. Canonical bounded
 * iterations reject malformed configuration before expensive crypto work.
 */
function parseHashParts(stored: string): { salt: string; iterations: number; hash: string } | null {
  if (typeof stored !== 'string' || stored.length > 170) return null;
  const parts = stored.split(HASH_SEPARATOR);

  if (parts.length === 3) {
    const [salt, iterStr, hash] = parts;
    const iterations = Number(iterStr);
    if (
      SALT_PATTERN.test(salt) && HASH_PATTERN.test(hash) &&
      /^[1-9]\d{0,6}$/.test(iterStr) &&
      Number.isSafeInteger(iterations) && iterations <= MAX_STORED_ITERATIONS
    ) {
      return { salt, iterations, hash };
    }
  }

  if (parts.length === 2) {
    const [salt, hash] = parts;
    if (SALT_PATTERN.test(salt) && HASH_PATTERN.test(hash)) {
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
  if (!isSupportedPinInput(pin)) throw new TypeError('Invalid PIN input');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, CURRENT_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${CURRENT_ITERATIONS}:${hash}`;
}

export function verifyHashedAdminPin(storedHash: string, providedPin: string): boolean {
  if (!isSupportedPinInput(providedPin)) return false;
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
  if (!storedPin || !isSupportedPinInput(providedPin)) {
    return false;
  }

  if (isHashedPin(storedPin)) {
    return verifyHashedAdminPin(storedPin, providedPin);
  }

  // Plaintext PIN detected — hash it on first successful match and warn
  // This path exists only for migration from legacy plaintext PINs
  return false;
}

/** Request paths use these bounded asynchronous helpers; sync helpers are for offline work/fixtures. */
export async function hashAdminPinAsync(pin: string): Promise<string> {
  if (!isSupportedPinInput(pin)) throw new TypeError('Invalid PIN input');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await derivePinAsync(pin, salt, CURRENT_ITERATIONS);
  return `${salt}:${CURRENT_ITERATIONS}:${hash.toString('hex')}`;
}

export async function verifyHashedAdminPinAsync(storedHash: string, providedPin: string): Promise<boolean> {
  if (!isSupportedPinInput(providedPin)) return false;
  const parts = parseHashParts(storedHash);
  if (!parts) return false;
  try {
    const derived = await derivePinAsync(providedPin, parts.salt, parts.iterations);
    return crypto.timingSafeEqual(derived, Buffer.from(parts.hash, 'hex'));
  } catch (error) {
    if (error instanceof AdminPinBusyError) throw error;
    return false;
  }
}

export async function verifyStoredAdminPinAsync(storedPin: string, providedPin: string): Promise<boolean> {
  return verifyHashedAdminPinAsync(storedPin, providedPin);
}
