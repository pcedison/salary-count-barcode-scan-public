import 'dotenv/config';
import {
  detectSourceFormat,
  isFlagMismatch,
  maskIdentifier
} from './lib/aes-migration-audit.mjs';
import { createPostgresClient } from './lib/postgres-client.mjs';

const HASH_SEPARATOR = ':';

function isHashedPin(value) {
  if (!value || !value.includes(HASH_SEPARATOR)) {
    return false;
  }

  const [salt, hash] = value.split(HASH_SEPARATOR);
  return Boolean(salt && hash);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = createPostgresClient(process.env.DATABASE_URL);

try {
  const employees = await sql`SELECT id, name, id_number, is_encrypted FROM employees ORDER BY id`;
  const summary = {
    total: employees.length,
    plaintext: 0,
    caesar: 0,
    aes: 0,
    empty: 0,
    flagMismatch: 0
  };

  console.log('=== Employee encryption status ===');

  for (const employee of employees) {
    const format = detectSourceFormat(employee.id_number, employee.is_encrypted === true);
    const flagMismatch = isFlagMismatch(format, employee.is_encrypted === true);

    summary[format] += 1;
    if (flagMismatch) {
      summary.flagMismatch += 1;
    }

    console.log(
      `  ID ${employee.id}: ${employee.name} | format=${format} | flag=${employee.is_encrypted ? 'encrypted' : 'plain'} | stored=${maskIdentifier(employee.id_number)}${flagMismatch ? ' | FLAG_MISMATCH' : ''}`
    );
  }

  console.log('\n=== Summary ===');
  console.log(`  Total: ${summary.total}`);
  console.log(`  Plaintext: ${summary.plaintext}`);
  console.log(`  Caesar: ${summary.caesar}`);
  console.log(`  AES: ${summary.aes}`);
  console.log(`  Empty: ${summary.empty}`);
  console.log(`  Flag mismatches: ${summary.flagMismatch}`);

  const settings = await sql`SELECT admin_pin FROM settings LIMIT 1`;
  if (settings.length > 0) {
    const adminPin = settings[0].admin_pin;
    const pinStatus = isHashedPin(adminPin) ? 'hashed (OK)' : 'plaintext (RISK)';
    console.log(`\nAdmin PIN: ${pinStatus} | length=${adminPin?.length ?? 0}`);
  }

  await sql.end();
} catch (error) {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  await sql.end().catch(() => {});
  process.exit(1);
}
