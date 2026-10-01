export type CsvCell = string | number | boolean | null | undefined;

export interface CsvOptions {
  /** Include the UTF-8 BOM so spreadsheet applications recognize Chinese text. */
  bom?: boolean;
}

// Ignore leading whitespace, controls and invisible formatting characters when
// detecting spreadsheet formulas. Quoting a CSV field alone does not disable them.
const formulaPrefix = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@]/;

export function encodeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number') {
    // Keep real negative amounts numeric; protect strings separately.
    return Number.isFinite(value) ? String(value) : '';
  }

  let text = String(value);
  if (typeof value === 'string' && formulaPrefix.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function encodeCsv(
  rows: ReadonlyArray<ReadonlyArray<CsvCell>>,
  options: CsvOptions = {},
): string {
  const contents = rows.map((row) => row.map(encodeCsvCell).join(',')).join('\r\n');
  return `${options.bom === false ? '' : '\uFEFF'}${contents}\r\n`;
}

/** Read CSV records without splitting quoted commas, quotes or line breaks. */
export function parseCsvRows(contents: string): string[][] {
  const source = contents.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ',' ) { finishField(); continue; }
    if (char === '\r' || char === '\n') {
      finishRow();
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      continue;
    }
    if (closedQuote) {
      if (char === ' ' || char === '\t') continue;
      throw new Error('Invalid characters after a quoted CSV field.');
    }
    if (char === '"') {
      if (field.trim()) throw new Error('Invalid quote in a CSV field.');
      field = ''; quoted = true;
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field.');
  if (field.length || row.length || closedQuote) finishRow();
  return rows;
}
