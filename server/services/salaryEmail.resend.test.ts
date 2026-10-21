import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalaryRecord } from '@shared/schema';
import type { SalaryAutomationConfig } from '../config/salaryAutomation';
import { createLogger } from '../utils/logger';

// Resend 模式只走 HTTPS fetch；SMTP 傳輸在此以 mock 取代，確認兩條路徑互不干擾。
const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: '<synthetic-smtp-id@example.test>' }));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));

import {
  RESEND_RETRY_DELAY_MS,
  RESEND_SEND_EMAIL_URL,
  SalaryEmailDeliveryError,
  sendMonthlySalaryEmail,
  sendSalaryAutomationTestEmail,
} from './salaryEmail';

// 合成假金鑰，僅用於確認不會外洩到錯誤或 log；不是任何真實憑證。
const SYNTHETIC_API_KEY = 'synthetic-resend-key-for-unit-tests-only';
const fetchMock = vi.fn<typeof fetch>();
const directories: string[] = [];

function resendConfig(overrides: Partial<SalaryAutomationConfig> = {}): SalaryAutomationConfig {
  return {
    enabled: true, timeZone: 'Asia/Taipei', runHour: 1, runMinute: 15, intervalMs: 3600000,
    emailRecipients: ['synthetic-a@example.test', 'synthetic-b@example.test'],
    smtpPort: 587, smtpSecure: false,
    resendApiKey: SYNTHETIC_API_KEY,
    resendFrom: '合成薪資系統 <payroll@mail.example.test>',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function syntheticPdf() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-resend-mail-'));
  directories.push(directory);
  const pdfPath = path.join(directory, 'salary-2026-09.pdf');
  const pdf = Buffer.from('%PDF-1.4\n% synthetic attachment only\n%%EOF\n');
  await writeFile(pdfPath, pdf);
  return { pdfPath, pdf };
}

function sentRequest(index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
}

// 讀 PDF 是真實 I/O，須等第一次呼叫 Resend 後才快轉重試等待時間。
async function advancePastRetryDelay() {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(RESEND_RETRY_DELAY_MS);
}

const monthly = (pdfPath: string, config = resendConfig()) => sendMonthlySalaryEmail({
  target: { year: 2026, month: 9 },
  records: [{ netSalary: 29300 }, { netSalary: 30700 }] as SalaryRecord[],
  pdfPath,
  config,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  createTransport.mockClear();
  sendMail.mockClear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('salary email through Resend HTTPS API', () => {
  it('posts the monthly report with Bearer auth, base64 PDF and a content-bound idempotency key', async () => {
    const { pdfPath, pdf } = await syntheticPdf();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-resend-id' }));

    const result = await monthly(pdfPath);

    expect(result).toEqual({ recipients: ['synthetic-a@example.test', 'synthetic-b@example.test'], messageId: 'synthetic-resend-id' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, headers, body } = sentRequest();
    expect(url).toBe(RESEND_SEND_EMAIL_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headers.Authorization).toBe(`Bearer ${SYNTHETIC_API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBeTruthy();
    expect(body).toMatchObject({
      from: '合成薪資系統 <payroll@mail.example.test>',
      to: ['synthetic-a@example.test', 'synthetic-b@example.test'],
      subject: '2026年9月薪資結算報告',
    });
    expect(body.text).toContain('薪資紀錄：2 筆');
    expect(body.text).toContain('實領總額：60,000 元');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toEqual({
      filename: 'salary-2026-09.pdf',
      content: pdf.toString('base64'),
      content_type: 'application/pdf',
    });
    expect(Buffer.from(body.attachments[0].content, 'base64')).toEqual(pdf);
    const expectedHash = createHash('sha256').update(String(init.body)).digest('hex');
    expect(headers['Idempotency-Key']).toBe(`monthly-salary-report/2026-09/${expectedHash}`);
    expect(headers['Idempotency-Key'].length).toBeLessThanOrEqual(256);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('falls back to SMTP_FROM as the Resend sender when RESEND_FROM is not set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-test-id' }));

    const result = await sendSalaryAutomationTestEmail({
      to: 'synthetic-test@example.test',
      config: resendConfig({ resendFrom: undefined, smtpFrom: 'Payroll <payroll@mail.example.test>' }),
      now: new Date('2026-10-02T00:15:00Z'),
    });

    expect(result).toEqual({ recipients: ['synthetic-test@example.test'], messageId: 'synthetic-test-id' });
    const { headers, body } = sentRequest();
    expect(body.from).toBe('Payroll <payroll@mail.example.test>');
    expect(body.subject).toBe('薪資自動化 Resend 測試');
    expect(body.text).toMatch(/2026\/10\/02\s+08:15:00/);
    expect(body).not.toHaveProperty('attachments');
    expect(headers).not.toHaveProperty('Idempotency-Key');
  });

  it('throws status and Resend error details on 4xx without retrying', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockImplementation(async () => jsonResponse(403, {
      statusCode: 403, name: 'validation_error', message: 'The mail.example.test domain is not verified.',
    }));

    const error = await monthly(pdfPath).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SalaryEmailDeliveryError);
    expect(error).toMatchObject({
      message: 'Resend API request failed with HTTP 403 (validation_error): The mail.example.test domain is not verified.',
      providerStatus: 403,
      providerErrorName: 'validation_error',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps only the status code when the error body is not Resend JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>synthetic proxy error</html>', { status: 502 }));

    await expect(sendSalaryAutomationTestEmail({ config: resendConfig() }))
      .rejects.toThrow(/^Resend API request failed with HTTP 502$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx monthly send once with the identical body and idempotency key', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { statusCode: 500, name: 'application_error', message: 'Synthetic outage.' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-after-retry' }));

    const pending = monthly(pdfPath);
    await advancePastRetryDelay();
    const result = await pending;

    expect(result.messageId).toBe('synthetic-after-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = sentRequest(0);
    const second = sentRequest(1);
    expect(second.init.body).toBe(first.init.body);
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });

  it('gives up after the second failed monthly attempt', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockImplementation(async () =>
      jsonResponse(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }));

    const pending = monthly(pdfPath).catch((caught: unknown) => caught);
    await advancePastRetryDelay();

    expect(await pending).toMatchObject({ providerStatus: 429, providerErrorName: 'rate_limit_exceeded' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports timeouts and does not retry sends that carry no idempotency key', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(sendSalaryAutomationTestEmail({ config: resendConfig() }))
      .rejects.toThrow('Resend API request timed out after 30000ms.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never exposes the API key or message content in errors or logs', async () => {
    const { pdfPath, pdf } = await syntheticPdf();
    fetchMock.mockImplementation(async () => jsonResponse(401, {
      statusCode: 401, name: 'validation_error', message: `API key ${SYNTHETIC_API_KEY} is invalid`,
    }));
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
    }

    const error = await monthly(pdfPath).catch((caught: unknown) => caught);
    createLogger('salary-automation').error('Monthly salary automation failed', error);

    expect(error).toBeInstanceOf(SalaryEmailDeliveryError);
    const exposed = [String((error as Error).message), JSON.stringify(error), ...output].join('\n');
    expect(exposed).toContain('[redacted]');
    expect(exposed).not.toContain(SYNTHETIC_API_KEY);
    expect(exposed).not.toContain(pdf.toString('base64'));
    expect(exposed).not.toContain('實領總額');
  });

  it('fails before calling Resend when the PDF attachment is missing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-resend-missing-'));
    directories.push(directory);

    await expect(monthly(path.join(directory, 'missing.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a Resend configuration without any sender before calling the API', async () => {
    const { pdfPath } = await syntheticPdf();
    const config = resendConfig({ resendFrom: undefined, smtpFrom: undefined });

    await expect(monthly(pdfPath, config)).rejects.toThrow('not configured');
    await expect(sendSalaryAutomationTestEmail({ config })).rejects.toThrow('RESEND_FROM (or SMTP_FROM)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps using SMTP when RESEND_API_KEY is not set', async () => {
    const { pdfPath } = await syntheticPdf();
    const config = resendConfig({
      resendApiKey: undefined,
      resendFrom: 'ignored-without-api-key@mail.example.test',
      smtpHost: 'smtp.example.test',
      smtpFrom: 'Payroll <payroll@example.test>',
    });

    const result = await monthly(pdfPath, config);

    expect(result.messageId).toBe('<synthetic-smtp-id@example.test>');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', port: 587, secure: false }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Payroll <payroll@example.test>',
      to: ['synthetic-a@example.test', 'synthetic-b@example.test'],
      attachments: [{ filename: 'salary-2026-09.pdf', path: pdfPath, contentType: 'application/pdf' }],
    }));
  });
});
