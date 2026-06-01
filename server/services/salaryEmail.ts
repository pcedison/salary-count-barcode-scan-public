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

function formatMonth(target: SalaryReportTarget): string {
  return `${target.year}-${String(target.month).padStart(2, '0')}`;
}

function buildEmailText(target: SalaryReportTarget, records: SalaryRecord[]): string {
  const totalNetSalary = records.reduce((sum, record) => sum + (record.netSalary || 0), 0);

  return [
    `${formatMonth(target)} monthly salary calculation is complete.`,
    '',
    `Salary records: ${records.length}`,
    `Total net salary: ${totalNetSalary.toLocaleString('zh-TW')}`,
    '',
    'The PDF salary report is attached.',
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
  const monthLabel = formatMonth(target);
  const info = await transporter.sendMail({
    from: config.smtpFrom,
    to: config.emailRecipients,
    subject: `${monthLabel} salary report`,
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
  const timestamp = now.toISOString();
  const info = await transporter.sendMail({
    from: config.smtpFrom,
    to: recipients,
    subject: 'Salary automation SMTP test',
    text: [
      'This is a salary automation SMTP test email.',
      '',
      `Sent at: ${timestamp}`,
      '',
      'No salary records were created or modified by this test.',
    ].join('\n'),
  });

  return {
    recipients,
    messageId: info.messageId,
  };
}
