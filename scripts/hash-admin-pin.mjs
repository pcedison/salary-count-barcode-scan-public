/**
 * Admin PIN Hash 遷移工具
 *
 * 將資料庫中的明文 admin PIN 轉為 PBKDF2 hash。
 *
 * Usage:
 *   npx tsx scripts/hash-admin-pin.mjs              # dry-run
 *   npx tsx scripts/hash-admin-pin.mjs --execute     # 執行
 */
import 'dotenv/config';
import crypto from 'crypto';
import { createPostgresClient } from './lib/postgres-client.mjs';

const CURRENT_ITERATIONS = 600_000;

function isHashedPin(value) {
  if (!value || !value.includes(':')) return false;
  const parts = value.split(':');
  // New format: salt:iterations:hash  OR  Legacy format: salt:hash
  if (parts.length === 3) {
    const [salt, iterStr, hash] = parts;
    const iter = parseInt(iterStr, 10);
    return Boolean(salt && hash && !Number.isNaN(iter) && iter > 0);
  }
  if (parts.length === 2) {
    const [salt, hash] = parts;
    return Boolean(salt && hash && salt.length === 32 && hash.length === 128);
  }
  return false;
}

function hashAdminPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, CURRENT_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${CURRENT_ITERATIONS}:${hash}`;
}

function verifyHashedPin(storedHash, pin) {
  const parts = storedHash.split(':');
  let salt, iterations, hash;
  if (parts.length === 3) {
    [salt, iterations, hash] = [parts[0], parseInt(parts[1], 10), parts[2]];
  } else {
    [salt, hash] = parts;
    iterations = 1000; // legacy
  }
  const computed = crypto.pbkdf2Sync(pin, salt, iterations, 64, 'sha512').toString('hex');
  const computedBuf = Buffer.from(computed, 'hex');
  const storedBuf = Buffer.from(hash, 'hex');
  if (computedBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, storedBuf);
}

async function main() {
  const isExecute = process.argv[2] === '--execute';

  const sql = createPostgresClient(process.env.DATABASE_URL);

  try {
    const [settings] = await sql`SELECT id, admin_pin FROM settings LIMIT 1`;

    if (!settings) {
      console.log('No settings row found. Nothing to do.');
      return;
    }

    const currentPin = settings.admin_pin;

    if (isHashedPin(currentPin)) {
      console.log('Admin PIN is already hashed. No migration needed.');
      return;
    }

    console.log(`\n=== Admin PIN Hash Migration ${isExecute ? '(EXECUTE)' : '(DRY RUN)'} ===\n`);
    console.log(`Current PIN: ${currentPin.length} chars (plaintext)`);

    const hashedPin = hashAdminPin(currentPin);
    console.log(`Hashed PIN: ${hashedPin.slice(0, 20)}... (${hashedPin.length} chars)`);

    // Verify round-trip
    const verified = verifyHashedPin(hashedPin, currentPin);
    console.log(`Round-trip verify: ${verified ? 'OK' : 'FAILED'}`);

    if (!verified) {
      console.error('Round-trip verification failed. Aborting.');
      process.exit(1);
    }

    if (!isExecute) {
      console.log('\n--- DRY RUN complete. Use --execute to apply. ---');
      return;
    }

    await sql`UPDATE settings SET admin_pin = ${hashedPin} WHERE id = ${settings.id}`;
    console.log('\nAdmin PIN hashed and updated in database.');

    // Final verification
    const [updated] = await sql`SELECT admin_pin FROM settings WHERE id = ${settings.id}`;
    const finalVerify = verifyHashedPin(updated.admin_pin, currentPin);
    console.log(`Final verification: ${finalVerify ? 'PASS' : 'FAIL'}`);

    if (!finalVerify) {
      console.error('Final verification failed. PIN may be corrupted.');
      process.exit(1);
    }

    console.log('\n=== Migration complete. ===');
  } finally {
    await sql.end();
  }
}

main().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
