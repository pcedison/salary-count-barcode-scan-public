import crypto from 'crypto';

const CURRENT_ITERATIONS = 600_000;

function printUsageAndExit() {
  console.error(
    'Usage: npm run super-pin:hash -- <plaintext-pin> [--raw]\n' +
    '   or: SUPER_ADMIN_PIN_PLAINTEXT=<plaintext-pin> npm run super-pin:hash -- [--raw]'
  );
  process.exit(1);
}

function hashAdminPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, CURRENT_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${CURRENT_ITERATIONS}:${hash}`;
}

const rawMode = process.argv.includes('--raw');
const positionalArgs = process.argv.slice(2).filter((value) => value !== '--raw');
const plaintextPin = positionalArgs[0] ?? process.env.SUPER_ADMIN_PIN_PLAINTEXT;

if (!plaintextPin || !plaintextPin.trim()) {
  printUsageAndExit();
}

const hashedPin = hashAdminPin(plaintextPin.trim());

if (rawMode) {
  console.log(hashedPin);
  process.exit(0);
}

console.log('Zeabur production requires a hashed SUPER_ADMIN_PIN.');
console.log('');
console.log('Paste this value into the Zeabur `SUPER_ADMIN_PIN` variable:');
console.log(hashedPin);
console.log('');
console.log('Do not keep the plaintext PIN in Zeabur after updating the variable.');
