import { z } from 'zod';
import { assertExternalDatabaseTlsUrl } from '../../shared/databaseTls.mjs';

import { assertCloudRuntimeStorage, getRuntimePathSummary } from './runtimePaths';
import { isKnownSelfSignedPoolerHost } from './databaseUrl';
import {
  getSalaryAutomationConfig,
  getSalaryEmailTransport,
  isSalaryEmailTransportConfigured,
} from './salaryAutomation';
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
    .default(5000),
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
  APP_DEPLOYMENT_MODE: z.enum(['local', 'cloudrun']).optional(),
  APP_BACKGROUND_SERVICES: z.enum(['enabled', 'disabled']).optional(),
  APP_AUDIT_SINK: z.enum(['file', 'stdout']).optional(),
  APP_STORAGE_MOUNT: z.string().optional(),
  APP_STORAGE_BUCKET: z.string().optional(),
  APP_PUBLIC_ORIGIN: z.string().optional(),
  ALLOW_DOTENV_IN_PRODUCTION: z.enum(['true', 'false']).optional(),
  ENCRYPTION_SALT: z.string().optional(),
  LINE_LOGIN_CHANNEL_ID: z.string().optional(),
  LINE_LOGIN_CHANNEL_SECRET: z.string().optional(),
  LINE_LOGIN_CALLBACK_URL: z.string().url('LINE_LOGIN_CALLBACK_URL must be a valid URL').optional(),
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_MESSAGING_CHANNEL_SECRET: z.string().optional(),
  SALARY_AUTOMATION_ENABLED: z.enum(['true', 'false']).optional(),
  SALARY_AUTOMATION_TIMEZONE: z.string().optional(),
  SALARY_AUTOMATION_RUN_HOUR: z.string().regex(/^\d+$/).optional(),
  SALARY_AUTOMATION_RUN_MINUTE: z.string().regex(/^\d+$/).optional(),
  SALARY_AUTOMATION_INTERVAL_MS: z.string().regex(/^\d+$/).optional(),
  SALARY_AUTOMATION_EMAIL_TO: z.string().optional(),
  SALARY_AUTOMATION_PUBLIC_BASE_URL: z.string().url('SALARY_AUTOMATION_PUBLIC_BASE_URL must be a valid URL').optional(),
  SALARY_PRINT_TOKEN_SECRET: optionalSecret('SALARY_PRINT_TOKEN_SECRET'),
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().regex(/^\d+$/).optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional()
});

export type ValidatedEnv = z.infer<typeof envSchema>;

function getConfiguredSuperAdminPin(): string | null {
  const configured = process.env.SUPER_ADMIN_PIN?.trim();
  return configured ? configured : null;
}

export function validateEnv(): ValidatedEnv {
  const validated = envSchema.parse(process.env);
  const isProduction = validated.NODE_ENV === 'production';
  const runtimePaths = getRuntimePathSummary();
  if (process.env.K_SERVICE && validated.APP_DEPLOYMENT_MODE !== 'cloudrun') {
    throw new Error('Cloud Run requires APP_DEPLOYMENT_MODE=cloudrun; ephemeral defaults are not allowed');
  }
  if (validated.APP_DEPLOYMENT_MODE === 'cloudrun') {
    if (!isProduction || validated.APP_BACKGROUND_SERVICES !== 'disabled' || validated.SALARY_AUTOMATION_ENABLED !== 'false') {
      throw new Error('Cloud Run requires production mode, APP_BACKGROUND_SERVICES=disabled and SALARY_AUTOMATION_ENABLED=false until worker ownership is implemented');
    }
    let origin: URL;
    try { origin = new URL(validated.APP_PUBLIC_ORIGIN || ''); }
    catch { throw new Error('Cloud Run requires an exact HTTPS APP_PUBLIC_ORIGIN'); }
    if (origin.protocol !== 'https:' || origin.origin !== validated.APP_PUBLIC_ORIGIN || origin.username || origin.password) {
      throw new Error('Cloud Run requires an exact HTTPS APP_PUBLIC_ORIGIN');
    }
    if (validated.ALLOWED_ORIGINS !== origin.origin || validated.SALARY_AUTOMATION_PUBLIC_BASE_URL !== origin.origin) {
      throw new Error('Cloud Run allowed origin and salary public base URL must match APP_PUBLIC_ORIGIN');
    }
    if (validated.LINE_LOGIN_CALLBACK_URL && validated.LINE_LOGIN_CALLBACK_URL !== `${origin.origin}/api/line/callback`) {
      throw new Error('Cloud Run LINE callback must match APP_PUBLIC_ORIGIN');
    }
    if (process.env.PGSSLREJECT_UNAUTHORIZED?.trim().toLowerCase() === 'false') {
      throw new Error('Cloud Run requires PostgreSQL certificate validation');
    }
    if (validated.DATABASE_URL) assertExternalDatabaseTlsUrl(validated.DATABASE_URL);
    assertCloudRuntimeStorage();
  }
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

  const configuredSuperAdminPin = getConfiguredSuperAdminPin();
  if (configuredSuperAdminPin && !isHashedPin(configuredSuperAdminPin)) {
    throw new Error('SUPER_ADMIN_PIN must use a supported hash format');
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

  if (validated.SALARY_AUTOMATION_ENABLED === 'true') {
    if (!validated.SALARY_AUTOMATION_EMAIL_TO) {
      throw new Error('SALARY_AUTOMATION_EMAIL_TO is required when salary automation is enabled');
    }

    // 與執行期共用同一個判斷：有 RESEND_API_KEY 走 Resend（不需 SMTP_HOST），否則走 SMTP。
    const salaryEmailConfig = getSalaryAutomationConfig(process.env);
    if (!isSalaryEmailTransportConfigured(salaryEmailConfig)) {
      throw new Error(
        getSalaryEmailTransport(salaryEmailConfig) === 'resend'
          ? 'RESEND_FROM is required when salary automation is enabled with RESEND_API_KEY'
          : 'SMTP_HOST and SMTP_FROM are required when salary automation is enabled ' +
            '(or set RESEND_API_KEY and RESEND_FROM to send through Resend)'
      );
    }
  }

  return validated;
}
