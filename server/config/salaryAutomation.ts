export interface SalaryAutomationConfig {
  enabled: boolean;
  timeZone: string;
  runHour: number;
  runMinute: number;
  intervalMs: number;
  emailRecipients: string[];
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  publicBaseUrl?: string;
  chromiumExecutablePath?: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.trim().toLowerCase() === 'true';
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  options: { min: number; max: number }
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.min(options.max, Math.max(options.min, parsed));
}

export function parseEmailRecipients(value = ''): string[] {
  return value
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

export function getSalaryAutomationConfig(env: NodeJS.ProcessEnv = process.env): SalaryAutomationConfig {
  return {
    enabled: parseBoolean(env.SALARY_AUTOMATION_ENABLED, false),
    timeZone: env.SALARY_AUTOMATION_TIMEZONE?.trim() || 'Asia/Taipei',
    runHour: parseInteger(env.SALARY_AUTOMATION_RUN_HOUR, 1, { min: 0, max: 23 }),
    runMinute: parseInteger(env.SALARY_AUTOMATION_RUN_MINUTE, 15, { min: 0, max: 59 }),
    intervalMs: parseInteger(env.SALARY_AUTOMATION_INTERVAL_MS, 60 * 60 * 1000, {
      min: 60 * 1000,
      max: 24 * 60 * 60 * 1000,
    }),
    emailRecipients: parseEmailRecipients(env.SALARY_AUTOMATION_EMAIL_TO),
    smtpHost: env.SMTP_HOST?.trim() || undefined,
    smtpPort: parseInteger(env.SMTP_PORT, 587, { min: 1, max: 65535 }),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER?.trim() || undefined,
    smtpPass: env.SMTP_PASS?.trim() || undefined,
    smtpFrom: env.SMTP_FROM?.trim() || undefined,
    publicBaseUrl: env.SALARY_AUTOMATION_PUBLIC_BASE_URL?.trim() || undefined,
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
  };
}

export function getSalaryAutomationConfigWarnings(config = getSalaryAutomationConfig()): string[] {
  const warnings: string[] = [];

  if (!config.enabled) {
    warnings.push('SALARY_AUTOMATION_ENABLED is not true; scheduler is disabled.');
  }

  if (config.emailRecipients.length === 0) {
    warnings.push('SALARY_AUTOMATION_EMAIL_TO is not configured.');
  }

  if (!config.smtpHost) {
    warnings.push('SMTP_HOST is not configured.');
  }

  if (!config.smtpFrom) {
    warnings.push('SMTP_FROM is not configured.');
  }

  return warnings;
}

export function isSalaryEmailConfigured(config = getSalaryAutomationConfig()): boolean {
  return Boolean(config.smtpHost && config.smtpFrom && config.emailRecipients.length > 0);
}
