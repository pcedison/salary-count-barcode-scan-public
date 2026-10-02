import { mkdtemp, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SalaryRecord } from '@shared/schema';
import type { SalaryAutomationConfig } from '../config/salaryAutomation';
import { sendMonthlySalaryEmail, sendSalaryAutomationTestEmail } from './salaryEmail';

// This fixture only captures SMTP bytes on loopback; it never relays or delivers mail.
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function smtpCapture(rejectRecipients = false) {
  const messages: string[] = [], recipients: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('220 localhost synthetic capture\r\n');
    let input = '', inData = false;
    socket.on('data', chunk => {
      input += chunk;
      while (input.length) {
        if (inData) {
          const end = input.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(input.slice(0, end).replace(/^\.\./gm, '.'));
          input = input.slice(end + 5);
          inData = false;
          socket.write('250 synthetic capture accepted\r\n');
          continue;
        }
        const end = input.indexOf('\r\n');
        if (end < 0) return;
        const command = input.slice(0, end);
        input = input.slice(end + 2);
        if (/^(EHLO|HELO) /i.test(command)) socket.write('250 localhost\r\n');
        else if (/^MAIL FROM:/i.test(command)) socket.write('250 sender accepted\r\n');
        else if (/^RCPT TO:/i.test(command)) {
          recipients.push(command.slice(8));
          socket.write(rejectRecipients ? '550 synthetic recipient rejected\r\n' : '250 recipient accepted\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 end with dot\r\n');
        } else if (command === 'QUIT') socket.end('221 goodbye\r\n');
        else if (command === 'RSET') socket.write('250 reset\r\n');
        else socket.write('502 unsupported synthetic command\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback SMTP fixture unavailable');
  const config: SalaryAutomationConfig = {
    enabled: false, timeZone: 'Asia/Taipei', runHour: 1, runMinute: 15,
    intervalMs: 3600000, emailRecipients: ['synthetic-a@example.test', 'synthetic-b@example.test'],
    smtpHost: '127.0.0.1', smtpPort: address.port, smtpSecure: false,
    smtpFrom: '合成薪資系統 <synthetic-sender@example.test>',
  };
  return { config, messages, recipients, connections: () => connections };
}

function quotedPrintable(value: string): Buffer {
  const unfolded = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index++) {
    if (unfolded[index] === '=' && /^[0-9a-f]{2}$/i.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(unfolded.slice(index + 1, index + 3), 16)); index += 2;
    } else bytes.push(unfolded.charCodeAt(index));
  }
  return Buffer.from(bytes);
}
function decodedWords(value: string): string {
  return value.replace(/\r\n[ \t]+/g, ' ').replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_match, encoding, content) =>
      (encoding.toLowerCase() === 'b' ? Buffer.from(content, 'base64') : quotedPrintable(content.replace(/_/g, ' '))).toString('utf8'));
}
function splitMime(part: string) {
  const separator = part.indexOf('\r\n\r\n');
  expect(separator).toBeGreaterThan(0);
  const headers = part.slice(0, separator).replace(/\r\n[ \t]+/g, ' ');
  const rawBody = part.slice(separator + 4).replace(/\r\n$/, '');
  const body = /Content-Transfer-Encoding: base64/i.test(headers) ? Buffer.from(rawBody, 'base64')
    : /Content-Transfer-Encoding: quoted-printable/i.test(headers) ? quotedPrintable(rawBody) : Buffer.from(rawBody);
  return { headers, body };
}
function attachmentFilename(headers: string): string {
  const continuations = [...headers.matchAll(/filename\*(\d+)\*?=(?:"([^"]*)"|([^;\s]*))/gi)]
    .sort((left, right) => Number(left[1]) - Number(right[1]));
  const value = continuations.length ? continuations.map(match => match[2] ?? match[3]).join('')
    : /filename\*=(?:"([^"]*)"|([^;\s]*))/i.exec(headers)?.slice(1).find(Boolean);
  if (value) return decodeURIComponent(value.replace(/^utf-8''/i, ''));
  return decodedWords(/filename="([^"]*)"/i.exec(headers)?.[1] ?? '');
}

describe('real Nodemailer salary transport on loopback only', () => {
  it('supports the application dynamic import and returns real stream MIME without networking', async () => {
    const nodemailer = await import('nodemailer');
    expect(nodemailer.createTransport).toBeTypeOf('function');
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const result = await transport.sendMail({
      from: 'synthetic-sender@example.test', to: 'synthetic-a@example.test',
      subject: '合成中文主旨', text: '合成內容，無任何真實薪資。',
    });
    const message = splitMime(result.message.toString());
    expect(decodedWords(message.headers)).toContain('合成中文主旨');
    expect(message.body.toString('utf8')).toContain('合成內容，無任何真實薪資。');
  });

  it('sends the real application monthly message with Chinese PDF filename, exact bytes and totals', async () => {
    const capture = await smtpCapture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-salary-mail-'));
    const pdfPath = path.join(directory, '2026-09-薪資報告.pdf');
    const pdf = Buffer.from('%PDF-1.4\n% synthetic attachment only\n%%EOF\n');
    await writeFile(pdfPath, pdf);
    const result = await sendMonthlySalaryEmail({ target: { year: 2026, month: 9 },
      records: [{ netSalary: 29300 }, { netSalary: 30700 }] as SalaryRecord[], pdfPath, config: capture.config });
    expect(result.recipients).toEqual(capture.config.emailRecipients);
    expect(result.messageId).toMatch(/^<.+>$/);
    expect(capture.recipients).toEqual(['<synthetic-a@example.test>', '<synthetic-b@example.test>']);
    expect(capture.messages).toHaveLength(1);
    const raw = capture.messages[0];
    const root = splitMime(raw);
    expect(decodedWords(root.headers)).toContain('2026年9月薪資結算報告');
    expect(decodedWords(root.headers)).toContain('合成薪資系統');
    const boundary = /boundary="([^"]+)"/i.exec(root.headers)?.[1];
    expect(boundary).toBeTruthy();
    const parts = raw.split(`--${boundary}`).slice(1, -1).map(part => splitMime(part.replace(/^\r\n/, '')));
    const text = parts.find(part => /Content-Type: text\/plain/i.test(part.headers));
    const attachment = parts.find(part => /Content-Type: application\/pdf/i.test(part.headers));
    expect(text?.body.toString('utf8')).toContain('薪資紀錄：2 筆');
    expect(text?.body.toString('utf8')).toContain('實領總額：60,000 元');
    expect(attachment?.headers).toMatch(/Content-Disposition: attachment/i);
    expect(attachmentFilename(attachment!.headers)).toBe(path.basename(pdfPath));
    expect(attachment?.body).toEqual(pdf);
  });

  it('uses explicit test recipients and preserves the Traditional Chinese timestamp', async () => {
    const capture = await smtpCapture();
    const result = await sendSalaryAutomationTestEmail({ to: ' synthetic-test@example.test ',
      config: capture.config, now: new Date('2026-10-02T00:15:00Z') });
    expect(result.recipients).toEqual(['synthetic-test@example.test']);
    expect(capture.recipients).toEqual(['<synthetic-test@example.test>']);
    const message = splitMime(capture.messages[0]);
    expect(decodedWords(message.headers)).toContain('薪資自動化 SMTP 測試');
    expect(message.body.toString('utf8')).toMatch(/2026\/10\/02\s+08:15:00/);
    expect(message.body.toString('utf8')).toContain('此測試不會新增或修改任何薪資紀錄。');
  });

  it('propagates a real SMTP recipient rejection without reporting success', async () => {
    const capture = await smtpCapture(true);
    await expect(sendSalaryAutomationTestEmail({ config: capture.config }))
      .rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
    expect(capture.messages).toHaveLength(0);
  });

  it('propagates missing attachment failure without a completed SMTP message', async () => {
    const capture = await smtpCapture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-salary-mail-missing-'));
    await expect(sendMonthlySalaryEmail({ target: { year: 2026, month: 9 }, records: [],
      pdfPath: path.join(directory, 'missing.pdf'), config: capture.config }))
      .rejects.toMatchObject({ code: 'ESTREAM' });
    expect(capture.messages).toHaveLength(0);
  });

  it('rejects incomplete explicit configuration before connecting to SMTP', async () => {
    const capture = await smtpCapture();
    await expect(sendMonthlySalaryEmail({ target: { year: 2026, month: 9 }, records: [],
      pdfPath: 'not-read.pdf', config: { ...capture.config, emailRecipients: [] } })).rejects.toThrow('not configured');
    await expect(sendSalaryAutomationTestEmail({ config: { ...capture.config, smtpHost: undefined } }))
      .rejects.toThrow('not configured');
    expect(capture.connections()).toBe(0);
  });
});
