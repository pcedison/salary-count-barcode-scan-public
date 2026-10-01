import { describe, expect, it } from 'vitest';

import { encodeCsv, encodeCsvCell } from './csv';

describe('CSV encoding', () => {
  it('quotes delimiters, double quotes and embedded line breaks', () => {
    expect(encodeCsv([
      ['Name', 'Note'],
      ['Test, Employee', 'A "quoted" note\r\nnext line'],
    ], { bom: false })).toBe(
      'Name,Note\r\n"Test, Employee","A ""quoted"" note\r\nnext line"\r\n',
    );
  });

  it('includes a BOM by default and supports empty cells', () => {
    expect(encodeCsv([['測試', null, undefined, true]])).toBe('\uFEFF測試,,,true\r\n');
  });

  it.each([
    '=SUM(1,2)', '+SUM(1)', '-SUM(1)', '@SUM(1)',
    '  =SUM(1)', '\t+SUM(1)', '\r\n@SUM(1)', '\u0000-SUM(1)',
    '\uFEFF=SUM(1)', '\u200b=SUM(1)',
  ])('neutralizes formulas in text: %j', (text) => {
    const escaped = encodeCsvCell(text);
    expect(escaped.startsWith("'") || escaped.startsWith('"' + "'")).toBe(true);
    expect(escaped).toContain(text.replace(/"/g, '""'));
  });

  it('retains numeric negative amounts and protects numeric-looking strings', () => {
    expect(encodeCsvCell(-125.5)).toBe('-125.5');
    expect(encodeCsvCell('-125.5')).toBe("'-125.5");
    expect(encodeCsvCell(0)).toBe('0');
    expect(encodeCsvCell(Number.NaN)).toBe('');
    expect(encodeCsvCell(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('does not alter ordinary text or formulas later in a text cell', () => {
    expect(encodeCsvCell('Employee A')).toBe('Employee A');
    expect(encodeCsvCell('Reason: + correction')).toBe('Reason: + correction');
  });
});
