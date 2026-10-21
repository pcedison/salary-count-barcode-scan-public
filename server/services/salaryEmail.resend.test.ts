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
  buildMonthlyReportIdempotencyKey,
  RESEND_DUPLICATE_SUPPRESSED_CODE,
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

async function syntheticPdf(marker = 'synthetic attachment only') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-resend-mail-'));
  directories.push(directory);
  const pdfPath = path.join(directory, 'salary-2026-09.pdf');
  const pdf = Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
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

const RECORDS = [
  { id: 101, revision: 0, netSalary: 29300 },
  { id: 102, revision: 0, netSalary: 30700 },
] as SalaryRecord[];

const monthly = (pdfPath: string, config = resendConfig(), records = RECORDS) => sendMonthlySalaryEmail({
  target: { year: 2026, month: 9 },
  records,
  pdfPath,
  config,
});

function resendError(status: number, name: string, message = `Synthetic ${name}.`) {
  return jsonResponse(status, { statusCode: status, name, message });
}

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
  it('posts the monthly report with Bearer auth, base64 PDF and a stable idempotency key', async () => {
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
    expect(headers['Idempotency-Key']).toMatch(/^monthly-salary-report\/2026-09\/[0-9a-f]{64}$/);
    expect(headers['Idempotency-Key'].length).toBeLessThanOrEqual(256);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends the test email without attachments, idempotency key or retries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-test-id' }));

    const result = await sendSalaryAutomationTestEmail({
      to: 'synthetic-test@example.test',
      config: resendConfig(),
      now: new Date('2026-10-02T00:15:00Z'),
    });

    expect(result).toEqual({ recipients: ['synthetic-test@example.test'], messageId: 'synthetic-test-id' });
    const { headers, body } = sentRequest();
    expect(body.from).toBe('合成薪資系統 <payroll@mail.example.test>');
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
      code: 'validation_error',
      providerStatus: 403,
      providerErrorName: 'validation_error',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps only the status code when the error body is not Resend JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>synthetic proxy error</html>', { status: 502 }));

    const error = await sendSalaryAutomationTestEmail({ config: resendConfig() }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'Resend API request failed with HTTP 502', code: 'resend_request_failed' });
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

    await expect(sendSalaryAutomationTestEmail({ config: resendConfig() })).rejects.toMatchObject({
      message: 'Resend API request timed out after 30000ms.',
      code: 'resend_request_timeout',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a timed-out monthly send once with the same body and key', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-replayed-id' }));

    const pending = monthly(pdfPath);
    await advancePastRetryDelay();

    expect((await pending).messageId).toBe('synthetic-replayed-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentRequest(1).init.body).toBe(sentRequest(0).init.body);
    expect(sentRequest(1).headers['Idempotency-Key']).toBe(sentRequest(0).headers['Idempotency-Key']);
  });

  it('reports network errors with a safe cause code after one monthly retry', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }) });
    });

    const pending = monthly(pdfPath).catch((caught: unknown) => caught);
    await advancePastRetryDelay();

    expect(await pending).toMatchObject({
      message: 'Resend API request failed before a response was received (ECONNRESET).',
      code: 'resend_network_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries 409 concurrent_idempotent_requests once', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock
      .mockResolvedValueOnce(resendError(409, 'concurrent_idempotent_requests'))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'synthetic-after-concurrent' }));

    const pending = monthly(pdfPath);
    await advancePastRetryDelay();

    expect((await pending).messageId).toBe('synthetic-after-concurrent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry HTTP 429 daily_quota_exceeded', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockImplementation(async () => resendError(429, 'daily_quota_exceeded'));

    await expect(monthly(pdfPath)).rejects.toMatchObject({
      code: 'daily_quota_exceeded', providerStatus: 429, providerErrorName: 'daily_quota_exceeded', retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a monthly 409 invalid_idempotent_request as already sent without retrying', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockImplementation(async () => resendError(409, 'invalid_idempotent_request'));
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });

    await expect(monthly(pdfPath)).resolves.toEqual({
      recipients: ['synthetic-a@example.test', 'synthetic-b@example.test'],
      duplicateSuppressed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toContain(RESEND_DUPLICATE_SUPPRESSED_CODE);
    expect(warnings.join('\n')).not.toContain(SYNTHETIC_API_KEY);
  });

  it('keeps 409 invalid_idempotent_request as an error for the test email', async () => {
    fetchMock.mockImplementation(async () => resendError(409, 'invalid_idempotent_request'));

    await expect(sendSalaryAutomationTestEmail({ config: resendConfig() }))
      .rejects.toMatchObject({ code: 'invalid_idempotent_request', providerStatus: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 2xx response without a JSON body as sent without a message id', async () => {
    const { pdfPath } = await syntheticPdf();
    fetchMock.mockResolvedValueOnce(new Response('synthetic accepted', { status: 200 }));

    await expect(monthly(pdfPath)).resolves.toEqual({
      recipients: ['synthetic-a@example.test', 'synthetic-b@example.test'],
      messageId: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the idempotency key stable when only the regenerated PDF bytes differ', async () => {
    const first = await syntheticPdf('rendered at 01:15');
    const second = await syntheticPdf('rendered at 02:15');
    fetchMock.mockImplementation(async () => jsonResponse(200, { id: 'synthetic-id' }));

    await monthly(first.pdfPath);
    await monthly(second.pdfPath);

    expect(sentRequest(1).init.body).not.toBe(sentRequest(0).init.body);
    expect(sentRequest(1).headers['Idempotency-Key']).toBe(sentRequest(0).headers['Idempotency-Key']);
  });

  it('changes the idempotency key when a forced rerun or settings change the report', () => {
    const target = { year: 2026, month: 9 };
    const message = {
      from: 'payroll@mail.example.test', to: ['synthetic-a@example.test'],
      subject: '2026年9月薪資結算報告', text: '實領總額：60,000 元',
      attachments: [{ filename: 'salary-2026-09.pdf', path: '/not-read.pdf', contentType: 'application/pdf' }],
    };
    const base = buildMonthlyReportIdempotencyKey(target, RECORDS, message);

    expect(buildMonthlyReportIdempotencyKey(target, RECORDS, { ...message, attachments: [{ ...message.attachments[0], path: '/other.pdf' }] }))
      .toBe(base);
    expect(buildMonthlyReportIdempotencyKey(target, [{ ...RECORDS[0], revision: 1 }, RECORDS[1]], message)).not.toBe(base);
    expect(buildMonthlyReportIdempotencyKey(target, RECORDS, { ...message, to: ['synthetic-b@example.test'] })).not.toBe(base);
    expect(buildMonthlyReportIdempotencyKey(target, RECORDS, { ...message, text: '實領總額：61,000 元' })).not.toBe(base);
    expect(buildMonthlyReportIdempotencyKey({ year: 2026, month: 10 }, RECORDS, message)).not.toBe(base);
  });

  it('never exposes the API key or message content in errors or logs', async () => {
    const { pdfPath, pdf } = await syntheticPdf();
    fetchMock.mockImplementation(async () => jsonResponse(401, {
      statusCode: 401, name: 'validation_error', message: `API key ${SYNTHETIC_API_KEY} is invalid`,
    }));
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
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

  it('requires RESEND_FROM in Resend mode and never falls back to SMTP_FROM', async () => {
    const { pdfPath } = await syntheticPdf();
    const config = resendConfig({ resendFrom: undefined, smtpFrom: 'Payroll <payroll@gmail.example.test>' });

    await expect(monthly(pdfPath, config)).rejects.toThrow('not configured');
    await expect(sendSalaryAutomationTestEmail({ config }))
      .rejects.toThrow('Salary email is not configured. Set RESEND_FROM for Resend.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
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
