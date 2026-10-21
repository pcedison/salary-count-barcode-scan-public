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
  /** 設定後改走 Resend HTTPS API 寄信（Railway Hobby 等封鎖 SMTP 的平台需要）。 */
  resendApiKey?: string;
  /** Resend 寄件人，Resend 模式必填（不回退 SMTP_FROM）。必須屬於 Resend 已驗證的網域。 */
  resendFrom?: string;
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
    resendApiKey: env.RESEND_API_KEY?.trim() || undefined,
    resendFrom: env.RESEND_FROM?.trim() || undefined,
    publicBaseUrl: env.SALARY_AUTOMATION_PUBLIC_BASE_URL?.trim() || undefined,
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
  };
}

export type SalaryEmailTransport = 'resend' | 'smtp';

/**
 * 寄信方式的唯一判斷點：有 RESEND_API_KEY 就走 Resend HTTPS API，否則維持 SMTP。
 * 啟動驗證、自動化流程與管理介面都必須透過這裡判斷，避免各處規則不一致。
 */
export function getSalaryEmailTransport(config: SalaryAutomationConfig): SalaryEmailTransport {
  return config.resendApiKey ? 'resend' : 'smtp';
}

export function getSalaryEmailSender(config: SalaryAutomationConfig): string | undefined {
  // Resend 必須明確設定 RESEND_FROM：SMTP_FROM 常是 Gmail 等未在 Resend 驗證的網域。
  return getSalaryEmailTransport(config) === 'resend' ? config.resendFrom : config.smtpFrom;
}

/** 寄件通道本身是否可用（不含收件人）；Resend 模式不需要 SMTP_HOST。 */
export function isSalaryEmailTransportConfigured(config = getSalaryAutomationConfig()): boolean {
  if (getSalaryEmailTransport(config) === 'resend') {
    return Boolean(getSalaryEmailSender(config));
  }

  return Boolean(config.smtpHost && config.smtpFrom);
}

export function getSalaryAutomationConfigWarnings(config = getSalaryAutomationConfig()): string[] {
  const warnings: string[] = [];

  if (!config.enabled) {
    warnings.push('SALARY_AUTOMATION_ENABLED is not true; scheduler is disabled.');
  }

  if (config.emailRecipients.length === 0) {
    warnings.push('SALARY_AUTOMATION_EMAIL_TO is not configured.');
  }

  if (getSalaryEmailTransport(config) === 'resend') {
    if (!getSalaryEmailSender(config)) {
      warnings.push('RESEND_FROM is not configured.');
    }

    return warnings;
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
  return isSalaryEmailTransportConfigured(config) && config.emailRecipients.length > 0;
}
