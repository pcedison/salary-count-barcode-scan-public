import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const ITERATIONS = 100000;

export const DEFAULT_ENCRYPTION_SALT = 'default-salt-please-change-in-production';

export function deriveKey(secretKey, salt = process.env.ENCRYPTION_SALT || DEFAULT_ENCRYPTION_SALT) {
  const saltBuffer = Buffer.from(salt, 'utf8');
  return crypto.pbkdf2Sync(secretKey, saltBuffer, ITERATIONS, KEY_LENGTH, 'sha512');
}

export function aesEncrypt(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted].join(':');
}

export function aesDecrypt(encryptedData, key) {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid AES data format');
  }

  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
