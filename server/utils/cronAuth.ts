import crypto from 'crypto';

/** 最短 32 字元；太短的密鑰視同未設定，端點一律拒絕。 */
export const MIN_CRON_SECRET_LENGTH = 32;

export function getSalaryAutomationCronSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env.SALARY_AUTOMATION_CRON_SECRET?.trim();
  return secret && secret.length >= MIN_CRON_SECRET_LENGTH ? secret : undefined;
}

/**
 * 驗證外部排程（Cloud Scheduler）送來的 `Authorization: Bearer <secret>`。
 * 先各自做 SHA-256 再 timingSafeEqual，長度不同也不洩漏時間差。
 */
export function isValidCronAuthorization(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return false;
  }

  const provided = crypto.createHash('sha256').update(match[1]).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(provided, expected);
}
