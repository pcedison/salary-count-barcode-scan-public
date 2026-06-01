import fs from 'fs';
import path from 'path';

import type { SalaryRecord } from '@shared/schema';

import { getRuntimePathSummary } from '../config/runtimePaths';
import { getSalaryAutomationConfig, type SalaryAutomationConfig } from '../config/salaryAutomation';
import { createSalaryPrintToken } from './salaryPrintToken';

export interface SalaryReportTarget {
  year: number;
  month: number;
}

function getSalaryRecordIds(records: SalaryRecord[]): number[] {
  const ids = records.map((record) => record.id).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length !== records.length) {
    throw new Error('Cannot generate salary PDF before salary records have database IDs.');
  }

  return ids;
}

export function getSalaryReportPdfPath(target: SalaryReportTarget): string {
  const summary = getRuntimePathSummary();
  return path.join(
    summary.runtimeRootDir,
    'salary-reports',
    String(target.year),
    `salary-${target.year}-${String(target.month).padStart(2, '0')}.pdf`
  );
}

export function resolveSalaryPrintBaseUrl(config: SalaryAutomationConfig): string {
  const configuredBaseUrl = config.publicBaseUrl?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  const port = process.env.PORT || '5000';
  return `http://127.0.0.1:${port}`;
}

export function buildMonthlySalaryPrintUrl(
  baseUrl: string,
  records: SalaryRecord[],
  token = createSalaryPrintToken(getSalaryRecordIds(records))
): string {
  const url = new URL('/print-monthly-salary', baseUrl);
  url.searchParams.set('ids', getSalaryRecordIds(records).join(','));
  url.searchParams.set('token', token);
  url.searchParams.set('automation', '1');
  return url.toString();
}

function resolveChromiumExecutablePath(config: SalaryAutomationConfig): string {
  const candidates = [
    config.chromiumExecutablePath,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean) as string[];

  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      'Chromium executable was not found. Set CHROMIUM_EXECUTABLE_PATH or install Chromium.'
    );
  }

  return executablePath;
}

export async function generateMonthlySalaryPdf(
  target: SalaryReportTarget,
  records: SalaryRecord[],
  config = getSalaryAutomationConfig()
): Promise<string> {
  if (records.length === 0) {
    throw new Error('Cannot generate salary PDF without salary records.');
  }

  const outputPath = getSalaryReportPdfPath(target);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutablePath(config),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const printUrl = buildMonthlySalaryPrintUrl(resolveSalaryPrintBaseUrl(config), records);

    await page.goto(printUrl, {
      waitUntil: 'networkidle0',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-print-ready="true"]', { timeout: 30_000 });
    await page.emulateMediaType('print');
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
      },
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}
