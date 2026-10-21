import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type { SalaryRecord } from '@shared/schema';

import {
  parseEmailRecipients,
  getSalaryAutomationConfig,
  getSalaryEmailSender,
  getSalaryEmailTransport,
  isSalaryEmailConfigured,
  isSalaryEmailTransportConfigured,
  type SalaryAutomationConfig,
} from '../config/salaryAutomation';
import type { SalaryReportTarget } from './salaryPdf';

// Resend 寄信 API 規格：https://resend.com/docs/api-reference/emails/send-email
export const RESEND_SEND_EMAIL_URL = 'https://api.resend.com/emails';
export const RESEND_REQUEST_TIMEOUT_MS = 30_000;
export const RESEND_RETRY_DELAY_MS = 2_000;
// Resend 拒絕沒有 User-Agent 的請求（官方 API introduction）。
const RESEND_USER_AGENT = 'barcode-scan-v3-salary-email';
const RESEND_ERROR_DETAIL_MAX_LENGTH = 300;

export interface SendMonthlySalaryEmailOptions {
  target: SalaryReportTarget;
  records: SalaryRecord[];
  pdfPath: string;
  config?: SalaryAutomationConfig;
}

export interface SendSalaryAutomationTestEmailOptions {
  to?: string | string[];
  config?: SalaryAutomationConfig;
  now?: Date;
}

interface SalaryEmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; path: string; contentType: string }>;
}

interface SalaryEmailDeliveryOptions {
  /**
   * 只給月結報表使用。帶上後 Resend 會以 Idempotency-Key 去重，
   * 並允許在暫時性失敗時以「完全相同的請求」自動重試一次。
   */
  idempotencyScope?: string;
}

/** Resend 寄信失敗。訊息只含狀態碼與 Resend 錯誤說明，不含 API key 或信件內容。 */
export class SalaryEmailDeliveryError extends Error {
  readonly providerStatus?: number;
  readonly providerErrorName?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { providerStatus?: number; providerErrorName?: string; retryable: boolean }
  ) {
    super(message);
    this.name = 'SalaryEmailDeliveryError';
    this.providerStatus = details.providerStatus;
    this.providerErrorName = details.providerErrorName;
    this.retryable = details.retryable;
  }
}

function formatMonthLabel(target: SalaryReportTarget): string {
  return `${target.year}年${target.month}月`;
}

function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function buildEmailText(target: SalaryReportTarget, records: SalaryRecord[]): string {
  const totalNetSalary = records.reduce((sum, record) => sum + (record.netSalary || 0), 0);

  return [
    `${formatMonthLabel(target)}薪資已完成自動結算。`,
    '',
    `薪資紀錄：${records.length} 筆`,
    `實領總額：${totalNetSalary.toLocaleString('zh-TW')} 元`,
    '',
    'PDF 薪資報表已隨信附上。',
  ].join('\n');
}

function resolveRecipients(to: string | string[] | undefined, config: SalaryAutomationConfig): string[] {
  if (Array.isArray(to)) {
    return to.map((recipient) => recipient.trim()).filter(Boolean);
  }

  if (typeof to === 'string' && to.trim()) {
    return parseEmailRecipients(to);
  }

  return config.emailRecipients;
}

function resolveSender(config: SalaryAutomationConfig): string {
  const sender = getSalaryEmailSender(config);
  if (!sender || !isSalaryEmailTransportConfigured(config)) {
    throw new Error(
      getSalaryEmailTransport(config) === 'resend'
        ? 'Salary email is not configured. Set RESEND_FROM (or SMTP_FROM) for Resend.'
        : 'Salary email is not configured. Set SMTP_HOST and SMTP_FROM.'
    );
  }

  return sender;
}

async function sendWithSmtp(config: SalaryAutomationConfig, message: SalaryEmailMessage) {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser || config.smtpPass
      ? {
          user: config.smtpUser,
          pass: config.smtpPass,
        }
      : undefined,
  });
  const info = await transporter.sendMail({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.attachments ? { attachments: message.attachments } : {}),
  });

  return info.messageId;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toResendError(response: Response, apiKey: string): Promise<SalaryEmailDeliveryError> {
  // Resend 錯誤格式：{ statusCode, name, message }（https://resend.com/docs/api-reference/errors）
  let name: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(await response.text()) as { name?: unknown; message?: unknown };
    name = typeof parsed.name === 'string' && /^[a-z_]{1,64}$/.test(parsed.name) ? parsed.name : undefined;
    detail = typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    // 非 JSON 回應（例如代理層的 HTML 錯誤頁）不寫入訊息，只保留狀態碼。
  }

  const safeDetail = detail
    ?.split(apiKey).join('[redacted]')
    .slice(0, RESEND_ERROR_DETAIL_MAX_LENGTH);
  const retryable =
    response.status >= 500 ||
    name === 'rate_limit_exceeded' ||
    name === 'concurrent_idempotent_requests';

  return new SalaryEmailDeliveryError(
    `Resend API request failed with HTTP ${response.status}${name ? ` (${name})` : ''}` +
      `${safeDetail ? `: ${safeDetail}` : ''}`,
    { providerStatus: response.status, providerErrorName: name, retryable }
  );
}

async function postToResend(apiKey: string, headers: Record<string, string>, body: string) {
  let response: Response;
  try {
    response = await fetch(RESEND_SEND_EMAIL_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    throw new SalaryEmailDeliveryError(
      errorName === 'TimeoutError' || errorName === 'AbortError'
        ? `Resend API request timed out after ${RESEND_REQUEST_TIMEOUT_MS}ms.`
        : `Resend API request failed before a response was received${typeof causeCode === 'string' ? ` (${causeCode})` : ''}.`,
      { retryable: true }
    );
  }

  if (!response.ok) {
    throw await toResendError(response, apiKey);
  }

  const payload = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return typeof payload?.id === 'string' ? payload.id : undefined;
}

async function sendWithResend(
  config: SalaryAutomationConfig,
  message: SalaryEmailMessage,
  options: SalaryEmailDeliveryOptions
): Promise<string | undefined> {
  const apiKey = config.resendApiKey;
  if (!apiKey) {
    throw new Error('Salary email is not configured. Set RESEND_API_KEY.');
  }

  const attachments = await Promise.all(
    (message.attachments ?? []).map(async (attachment) => ({
      filename: attachment.filename,
      content: (await fs.readFile(attachment.path)).toString('base64'),
      content_type: attachment.contentType,
    }))
  );
  const body = JSON.stringify({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': RESEND_USER_AGENT,
  };

  if (options.idempotencyScope) {
    // 金鑰 = 月份 + 完整請求內容雜湊（Resend 保留 24 小時、上限 256 字元）。
    // 同一請求重送時 Resend 回傳原結果、不會再寄一次；管理員更正後重新寄送
    // 內容不同，會得到新金鑰而正常寄出，不會被 409 invalid_idempotent_request 擋下。
    const contentHash = createHash('sha256').update(body).digest('hex');
    headers['Idempotency-Key'] = `${options.idempotencyScope}/${contentHash}`;
  }

  // 沒有 Idempotency-Key 時不自動重試，避免逾時但其實已寄出時重複寄信。
  const maxAttempts = options.idempotencyScope ? 2 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postToResend(apiKey, headers, body);
    } catch (error) {
      const retryable = error instanceof SalaryEmailDeliveryError && error.retryable;
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      await wait(RESEND_RETRY_DELAY_MS);
    }
  }
}

async function deliverSalaryEmail(
  config: SalaryAutomationConfig,
  message: SalaryEmailMessage,
  options: SalaryEmailDeliveryOptions = {}
): Promise<string | undefined> {
  if (getSalaryEmailTransport(config) === 'resend') {
    return sendWithResend(config, message, options);
  }

  return sendWithSmtp(config, message);
}

export async function sendMonthlySalaryEmail({
  target,
  records,
  pdfPath,
  config = getSalaryAutomationConfig(),
}: SendMonthlySalaryEmailOptions): Promise<{ recipients: string[]; messageId?: string }> {
  if (!isSalaryEmailConfigured(config)) {
    throw new Error(
      'Salary email is not configured. Set SALARY_AUTOMATION_EMAIL_TO and either ' +
        'RESEND_API_KEY with RESEND_FROM, or SMTP_HOST and SMTP_FROM.'
    );
  }

  const monthKey = `${target.year}-${String(target.month).padStart(2, '0')}`;
  const messageId = await deliverSalaryEmail(
    config,
    {
      from: resolveSender(config),
      to: config.emailRecipients,
      subject: `${formatMonthLabel(target)}薪資結算報告`,
      text: buildEmailText(target, records),
      attachments: [
        {
          filename: path.basename(pdfPath),
          path: pdfPath,
          contentType: 'application/pdf',
        },
      ],
    },
    { idempotencyScope: `monthly-salary-report/${monthKey}` }
  );

  return {
    recipients: config.emailRecipients,
    messageId,
  };
}

export async function sendSalaryAutomationTestEmail({
  to,
  config = getSalaryAutomationConfig(),
  now = new Date(),
}: SendSalaryAutomationTestEmailOptions = {}): Promise<{ recipients: string[]; messageId?: string }> {
  const recipients = resolveRecipients(to, config);
  if (recipients.length === 0) {
    throw new Error('No test email recipient configured. Set SALARY_AUTOMATION_EMAIL_TO or pass a recipient.');
  }

  const from = resolveSender(config);
  const transportLabel = getSalaryEmailTransport(config) === 'resend' ? 'Resend' : 'SMTP';
  const timestamp = formatDateTime(now, config.timeZone);
  const messageId = await deliverSalaryEmail(config, {
    from,
    to: recipients,
    subject: `薪資自動化 ${transportLabel} 測試`,
    text: [
      `這是一封薪資自動化 ${transportLabel} 測試信。`,
      '',
      `寄送時間：${timestamp}`,
      '',
      '此測試不會新增或修改任何薪資紀錄。',
    ].join('\n'),
  });

  return {
    recipients,
    messageId,
  };
}
