import path from 'path';

import type { SalaryRecord } from '@shared/schema';

import {
  parseEmailRecipients,
  getSalaryAutomationConfig,
  isSalaryEmailConfigured,
  type SalaryAutomationConfig,
} from '../config/salaryAutomation';
import type { SalaryReportTarget } from './salaryPdf';

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

async function createSalaryTransporter(config: SalaryAutomationConfig) {
  if (!config.smtpHost || !config.smtpFrom) {
    throw new Error('Salary email is not configured. Set SMTP_HOST and SMTP_FROM.');
  }

  const nodemailer = await import('nodemailer');
  return nodemailer.createTransport({
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
}

export async function sendMonthlySalaryEmail({
  target,
  records,
  pdfPath,
  config = getSalaryAutomationConfig(),
}: SendMonthlySalaryEmailOptions): Promise<{ recipients: string[]; messageId?: string }> {
  if (!isSalaryEmailConfigured(config)) {
    throw new Error('Salary email is not configured. Set SMTP_HOST, SMTP_FROM, and SALARY_AUTOMATION_EMAIL_TO.');
  }

  const transporter = await createSalaryTransporter(config);
  const monthLabel = formatMonthLabel(target);
  const info = await transporter.sendMail({
    from: config.smtpFrom,
    to: config.emailRecipients,
    subject: `${monthLabel}薪資結算報告`,
    text: buildEmailText(target, records),
    attachments: [
      {
        filename: path.basename(pdfPath),
        path: pdfPath,
        contentType: 'application/pdf',
      },
    ],
  });

  return {
    recipients: config.emailRecipients,
    messageId: info.messageId,
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

  const transporter = await createSalaryTransporter(config);
  const timestamp = formatDateTime(now, config.timeZone);
  const info = await transporter.sendMail({
    from: config.smtpFrom,
    to: recipients,
    subject: '薪資自動化 SMTP 測試',
    text: [
      '這是一封薪資自動化 SMTP 測試信。',
      '',
      `寄送時間：${timestamp}`,
      '',
      '此測試不會新增或修改任何薪資紀錄。',
    ].join('\n'),
  });

  return {
    recipients,
    messageId: info.messageId,
  };
}
