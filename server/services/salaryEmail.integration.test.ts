import { promises as fs } from 'fs';
import net, { type Socket } from 'net';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { getSalaryAutomationConfig } from '../config/salaryAutomation';
import { sendMonthlySalaryEmail, sendSalaryAutomationTestEmail } from './salaryEmail';

async function createLoopbackSmtpServer() {
  const messages: { recipients: string[]; data: string }[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 loopback.test ESMTP\r\n');

    let buffer = '';
    let receivingData = false;
    let recipients: string[] = [];
    let messageLines: string[] = [];
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let endOfLine: number;
      while ((endOfLine = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, endOfLine);
        buffer = buffer.slice(endOfLine + 2);

        if (receivingData) {
          if (line === '.') {
            messages.push({ recipients, data: messageLines.join('\r\n') });
            receivingData = false;
            socket.write('250 Message accepted\r\n');
          } else {
            messageLines.push(line.replace(/^\.\./, '.'));
          }
        } else if (/^(EHLO|HELO) /i.test(line)) {
          socket.write('250 loopback.test\r\n');
        } else if (/^MAIL FROM:/i.test(line)) {
          recipients = [];
          messageLines = [];
          socket.write('250 Sender accepted\r\n');
        } else if (/^RCPT TO:/i.test(line)) {
          recipients.push(line.match(/<([^>]+)>/)?.[1] ?? '');
          socket.write('250 Recipient accepted\r\n');
        } else if (line.toUpperCase() === 'DATA') {
          receivingData = true;
          socket.write('354 End with a single dot\r\n');
        } else if (line.toUpperCase() === 'QUIT') {
          socket.end('221 Goodbye\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine loopback SMTP port');
  }

  return {
    messages,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

describe('salary email SMTP compatibility', () => {
  it('sends the salary PDF attachment and test email through the actual local SMTP transport', async () => {
    const smtp = await createLoopbackSmtpServer();
    const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'salary-email-test-'));
    const pdfPath = path.join(fixtureDirectory, 'salary-test.pdf');
    const pdfContent = Buffer.from('%PDF-1.4\nsynthetic salary attachment\n%%EOF');
    const config = getSalaryAutomationConfig({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURE: 'false',
      SMTP_FROM: 'sender@loopback.test',
      SALARY_AUTOMATION_EMAIL_TO: 'recipient@loopback.test'
    });

    try {
      await fs.writeFile(pdfPath, pdfContent);
      const salary = await sendMonthlySalaryEmail({
        target: { year: 2026, month: 9 },
        records: [],
        pdfPath,
        config
      });
      expect(salary.recipients).toEqual(['recipient@loopback.test']);
      expect(salary.messageId).toBeTruthy();
      expect(smtp.messages[0].recipients).toEqual(['recipient@loopback.test']);
      expect(smtp.messages[0].data).toContain('Content-Type: application/pdf');
      expect(smtp.messages[0].data).toContain('filename=salary-test.pdf');
      expect(smtp.messages[0].data).toContain(pdfContent.toString('base64'));

      const testEmail = await sendSalaryAutomationTestEmail({
        to: ['test@loopback.test'],
        config,
        now: new Date('2026-10-01T00:00:00Z')
      });
      expect(testEmail.recipients).toEqual(['test@loopback.test']);
      expect(testEmail.messageId).toBeTruthy();
      expect(smtp.messages).toHaveLength(2);
      expect(smtp.messages[1].recipients).toEqual(['test@loopback.test']);
      expect(smtp.messages[1].data).toContain('Subject:');
      expect(smtp.messages[1].data).not.toContain('Content-Type: application/pdf');
    } finally {
      await smtp.close();
      await fs.rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
