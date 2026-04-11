import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const IV_LENGTH_LEGACY = 12; // GCM standard 12-byte IV used by older data
const TAG_LENGTH = 16;
const ITERATIONS = 100000;

export class SecureEncryption {
  private key: Buffer;

  constructor(secretKey: string, salt?: string) {
    if (!secretKey || secretKey.length < 32) {
      throw new Error('加密金鑰必須至少 32 字元');
    }

    const saltBuffer = salt
      ? Buffer.from(salt, 'utf8')
      : Buffer.from(
          process.env.ENCRYPTION_SALT || 'default-salt-please-change-in-production',
          'utf8'
        );

    this.key = crypto.pbkdf2Sync(secretKey, saltBuffer, ITERATIONS, KEY_LENGTH, 'sha512');
  }

  encrypt(text: string): string {
    if (!text) {
      throw new Error('待加密文字不能為空');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return [iv.toString('hex'), tag.toString('hex'), encrypted].join(':');
  }

  decrypt(encryptedData: string): string {
    if (!encryptedData) {
      throw new Error('待解密文字不能為空');
    }

    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('加密資料格式錯誤');
    }

    const [ivHex, tagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

export function isAESEncrypted(text: string): boolean {
  if (!text) {
    return false;
  }

  const parts = text.split(':');
  if (parts.length !== 3) {
    return false;
  }

  const [ivHex, tagHex, encrypted] = parts;
  const hexRegex = /^[0-9a-fA-F]+$/;

  const validIvLength = ivHex.length === IV_LENGTH * 2 || ivHex.length === IV_LENGTH_LEGACY * 2;

  return (
    hexRegex.test(ivHex) &&
    hexRegex.test(tagHex) &&
    hexRegex.test(encrypted) &&
    validIvLength &&
    tagHex.length === TAG_LENGTH * 2
  );
}

export function getEncryptionInstance(): SecureEncryption {
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey) {
    throw new Error('未設定 ENCRYPTION_KEY 環境變數');
  }

  return new SecureEncryption(encryptionKey);
}

export function encrypt(text: string): string {
  return getEncryptionInstance().encrypt(text);
}

export function decrypt(encryptedData: string): string {
  return getEncryptionInstance().decrypt(encryptedData);
}
