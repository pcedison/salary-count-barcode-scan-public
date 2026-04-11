import { z } from 'zod';

import { getRuntimePathSummary } from './runtimePaths';
import { isKnownSelfSignedPoolerHost } from './databaseUrl';
import { isHashedPin } from '../utils/adminPinAuth';
import { createLogger } from '../utils/logger';

const log = createLogger('env');

const optionalSecret = (name: string) =>
  z
    .string()
    .optional()
    .refine((value) => value === undefined || value.length >= 32, {
      message: `${name} must be at least 32 characters long`
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default('5000'),
  SESSION_TIMEOUT: z
    .string()
    .regex(/^\d+$/, 'SESSION_TIMEOUT must be a numeric number of minutes')
    .optional(),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'DATABASE_URL must point to PostgreSQL'
    }),
  USE_AES_ENCRYPTION: z.enum(['true', 'false']).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).optional(),
  SESSION_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
  SESSION_SECRET: optionalSecret('SESSION_SECRET'),
  SCAN_DEVICE_TOKEN: optionalSecret('SCAN_DEVICE_TOKEN'),
  ENCRYPTION_KEY: optionalSecret('ENCRYPTION_KEY'),
  BACKUP_ENCRYPTION_KEY: optionalSecret('BACKUP_ENCRYPTION_KEY'),
  APP_RUNTIME_DIR: z.string().optional(),
  APP_BACKUP_DIR: z.string().optional(),
  APP_LOG_DIR: z.string().optional(),
  ALLOW_DOTENV_IN_PRODUCTION: z.enum(['true', 'false']).optional(),
  ENCRYPTION_SALT: z.string().optional(),
  LINE_LOGIN_CHANNEL_ID: z.string().optional(),
  LINE_LOGIN_CHANNEL_SECRET: z.string().optional(),
  LINE_LOGIN_CALLBACK_URL: z.string().url('LINE_LOGIN_CALLBACK_URL must be a valid URL').optional(),
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_MESSAGING_CHANNEL_SECRET: z.string().optional()
});

export type ValidatedEnv = z.infer<typeof envSchema>;

function getProductionUnsafePin(): string | null {
  const configured = process.env.SUPER_ADMIN_PIN?.trim();
  return configured ? configured : null;
}

export function validateEnv(): ValidatedEnv {
  const validated = envSchema.parse(process.env);
  const isProduction = validated.NODE_ENV === 'production';
  const runtimePaths = getRuntimePathSummary();
  const secureCookiesEnabled =
    validated.SESSION_SECURE === 'true' ||
    (validated.SESSION_SECURE !== 'false' && isProduction);
  const allowsKnownPoolerSslException =
    validated.DATABASE_URL
      ? isKnownSelfSignedPoolerHost(validated.DATABASE_URL)
      : false;

  if (isProduction && process.env.PGSSLREJECT_UNAUTHORIZED?.trim().toLowerCase() === 'false') {
    if (!allowsKnownPoolerSslException) {
      throw new Error(
        'PGSSLREJECT_UNAUTHORIZED=false is only allowed in production for known self-signed pooler hosts'
      );
    }

    log.warn(
      'PGSSLREJECT_UNAUTHORIZED=false is enabled for a known self-signed pooler host in production'
    );
  }

  if (isProduction && validated.SESSION_SECURE !== 'true') {
    throw new Error('SESSION_SECURE must be set to true in production');
  }

  if (isProduction && !validated.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production and must be at least 32 characters');
  }

  const configuredSuperAdminPin = getProductionUnsafePin();
  if (isProduction && configuredSuperAdminPin && !isHashedPin(configuredSuperAdminPin)) {
    throw new Error('SUPER_ADMIN_PIN must be hashed in production');
  }

  if (isProduction && !validated.BACKUP_ENCRYPTION_KEY && !validated.ENCRYPTION_KEY) {
    throw new Error('Production backups require BACKUP_ENCRYPTION_KEY or ENCRYPTION_KEY');
  }

  if (isProduction && runtimePaths.insideWorkspace.backupRootDir) {
    throw new Error('APP_BACKUP_DIR must resolve outside the workspace in production');
  }

  if (isProduction && runtimePaths.insideWorkspace.auditLogDir) {
    throw new Error('APP_LOG_DIR must resolve outside the workspace in production');
  }

  if (validated.SESSION_SAME_SITE === 'none' && !secureCookiesEnabled) {
    throw new Error('SESSION_SAME_SITE=none requires SESSION_SECURE=true');
  }

  if (validated.USE_AES_ENCRYPTION === 'true' && !validated.ENCRYPTION_KEY) {
    throw new Error('USE_AES_ENCRYPTION=true requires an ENCRYPTION_KEY with at least 32 characters');
  }

  if (!validated.SESSION_SECRET) {
    log.warn('SESSION_SECRET is not set; admin sessions will use the development fallback secret');
  }

  if (isProduction && validated.ALLOW_DOTENV_IN_PRODUCTION === 'true') {
    log.warn('ALLOW_DOTENV_IN_PRODUCTION=true bypasses the production secret-source guard');
  }

  if (isProduction && !validated.SCAN_DEVICE_TOKEN) {
    log.warn('SCAN_DEVICE_TOKEN is not set; /api/raspberry-scan will be disabled in production');
  }

  if (!validated.ENCRYPTION_KEY) {
    log.warn('ENCRYPTION_KEY is not set; AES encryption features will remain disabled');
  }

  if (validated.USE_AES_ENCRYPTION === 'true' && !validated.ENCRYPTION_SALT) {
    log.warn('ENCRYPTION_SALT is not set; AES encryption should use an explicit salt');
  }

  const lineVars = [
    validated.LINE_LOGIN_CHANNEL_ID,
    validated.LINE_LOGIN_CHANNEL_SECRET,
    validated.LINE_LOGIN_CALLBACK_URL,
    validated.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN,
    validated.LINE_MESSAGING_CHANNEL_SECRET
  ];
  const lineSetCount = lineVars.filter(Boolean).length;
  if (lineSetCount > 0 && lineSetCount < 5) {
    throw new Error(
      'LINE integration must be configured as a complete set: ' +
      'LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET, LINE_LOGIN_CALLBACK_URL, ' +
      'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN, LINE_MESSAGING_CHANNEL_SECRET'
    );
  }
  if (lineSetCount === 0) {
    log.warn('LINE integration is not configured; LINE features remain disabled');
  }

  return validated;
}
