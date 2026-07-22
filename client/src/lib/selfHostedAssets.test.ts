import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 永續性守門測試:前端資產必須完全自架。
 *
 * 背景:主字型曾由 cdn.jsdelivr.net 以 @latest 載入(版本不鎖定、依賴外部服務存活),
 * 且 production CSP 根本未允許 jsdelivr,正式環境實際上載入失敗、無聲退化成備援字型。
 * Material Icons / Roboto 亦曾由 fonts.googleapis.com 動態注入。
 * 修正後所有字型改由 npm 套件(@fontsource/*)自架,由 Vite 打包進 dist。
 *
 * 此測試靜態掃描 client 原始碼,防止任何人再引入執行期 CDN 依賴:
 * 一旦圖示字型不再載入,殘留的 material-icons ligature 會直接顯示英文字。
 */

const CLIENT_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = join(CLIENT_ROOT, 'src');

const RUNTIME_CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|css|html)$/.test(entry) && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('self-hosted frontend assets', () => {
  const sourceFiles = [...collectSourceFiles(SRC_ROOT), join(CLIENT_ROOT, 'index.html')];

  it('does not reference runtime CDN hosts anywhere in client source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const host of RUNTIME_CDN_HOSTS) {
        if (content.includes(host)) {
          offenders.push(`${file} → ${host}`);
        }
      }
    }
    expect(offenders, '前端不得在執行期依賴外部 CDN(字型/樣式必須自架)').toEqual([]);
  });

  it('does not use the material-icons ligature font in any component', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('material-icons')) {
        offenders.push(file);
      }
    }
    expect(offenders, 'material-icons 字型已移除,殘留 class 會直接顯示英文字;請改用 lucide-react').toEqual([]);
  });
});
